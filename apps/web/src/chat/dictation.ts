import type { DictationAdapter } from "@assistant-ui/react"
import {
  DICTATION_SAMPLE_RATE,
  DICTATION_STOP,
  DictationEvent,
} from "@workspace/contracts"
import { getDictationSocket } from "@/lib/api/server"

/**
 * Voice dictation for the composer, as assistant-ui's `DictationAdapter`: the
 * microphone streams to the api's relay, and the words come back as they are
 * recognised, each partial replacing the last in the composer until its phrase
 * settles. One class, so the provider behind the relay can change without the
 * composer knowing: the wire is `DictationEvent` either way.
 *
 * Why it is shaped as it is, after hermes-agent's `voice-stream.ts` and
 * `use-mic-recorder.ts` (MIT, Nous Research): the capture taps the mic's own
 * rate through a `ScriptProcessor`, which works wherever audio does, and is
 * brought to 16 kHz here by averaging, so a capture callback is the only work
 * on the audio's way. The socket carries the one ticket the owner's session
 * minted for it; any failure ends the session and says so.
 */

/** What a start that did not work says, in a few words, beside the composer. */
export const NOTICES = {
  denied: "Microphone access is off. Allow it in your browser to dictate.",
  missing: "No microphone found.",
  busy: "Another app is using the microphone.",
  unsupported: "Dictation isn't available in this browser.",
  failed: "Dictation couldn't start. Try again.",
  dropped: "Dictation stopped unexpectedly.",
} as const

/** How long a notice stays before it clears itself. */
const NOTICE_MS = 8_000
/** How long a start waits for the socket to open. */
const OPEN_MS = 8_000
/** How long a stop waits for the last words before it closes the socket itself. */
const SETTLE_MS = 3_000

/** A notice the composer shows, as a store a hook can read. */
export class Notice {
  text: string | null = null
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }
  readonly read = () => this.text

  set(text: string | null) {
    clearTimeout(this.timer)
    this.text = text
    if (text) this.timer = setTimeout(() => this.set(null), NOTICE_MS)
    for (const listener of this.listeners) listener()
  }
}

/**
 * Brings capture to the model's rate: each output sample is the mean of the
 * input samples that fall in its slot, so it needs no filter of its own and
 * carries what is left over from one chunk to the next.
 */
export function resampler(from: number, to = DICTATION_SAMPLE_RATE) {
  const slot = from / to
  let taken = 0
  let made = 0
  let sum = 0
  let count = 0
  return (input: Float32Array): Int16Array => {
    const out: number[] = []
    for (const sample of input) {
      sum += sample
      count++
      taken++
      if (taken >= (made + 1) * slot) {
        out.push(sum / count)
        made++
        sum = 0
        count = 0
      }
    }
    return Int16Array.from(out, (value) => {
      const clipped = Math.max(-1, Math.min(1, value))
      return clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff
    })
  }
}

/** A running capture. */
export type Microphone = { stop: () => void }

/** Opens the microphone and calls `onAudio` with 16 kHz mono 16-bit PCM. */
export async function openMicrophone(
  onAudio: (pcm: ArrayBuffer) => void
): Promise<Microphone> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  })
  const context = new AudioContext()
  const source = context.createMediaStreamSource(stream)
  const tap = context.createScriptProcessor(4096, 1, 1)
  const down = resampler(context.sampleRate)
  tap.onaudioprocess = (event) =>
    onAudio(down(event.inputBuffer.getChannelData(0)).buffer as ArrayBuffer)
  // A tap only fires while it is connected through; its output stays silent.
  source.connect(tap)
  tap.connect(context.destination)
  return {
    stop: () => {
      tap.disconnect()
      source.disconnect()
      for (const track of stream.getTracks()) track.stop()
      void context.close()
    },
  }
}

/** The notice for a microphone that would not open. */
export function microphoneNotice(error: unknown): string {
  const name = error instanceof DOMException ? error.name : ""
  if (name === "NotAllowedError" || name === "SecurityError") {
    return NOTICES.denied
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return NOTICES.missing
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return NOTICES.busy
  }
  return NOTICES.failed
}

type Socket = Pick<
  WebSocket,
  "send" | "close" | "addEventListener" | "readyState" | "binaryType"
>

export type DictationParts = {
  /** The relay's address with a ticket on it, or null with no session. */
  socket: () => Promise<string | null>
  microphone: typeof openMicrophone
  connect: (url: string) => Socket
  supported: () => boolean
}

const REAL: DictationParts = {
  socket: () => getDictationSocket(),
  microphone: openMicrophone,
  connect: (url) => new WebSocket(url),
  supported: () =>
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof AudioContext !== "undefined" &&
    typeof WebSocket !== "undefined",
}

const OPEN = 1

const parse = (data: unknown): unknown => {
  try {
    return JSON.parse(String(data))
  } catch {
    return null
  }
}

export class RelayDictationAdapter implements DictationAdapter {
  readonly notice = new Notice()
  private settled: string[] = []

  /**
   * The phrases the last dictation settled, once, if it ended by being
   * stopped: the words to tidy. A cancelled or failed dictation has none.
   */
  take(): string[] {
    const phrases = this.settled
    this.settled = []
    return phrases
  }

  constructor(private readonly parts: DictationParts = REAL) {}

  listen(): DictationAdapter.Session {
    const { notice, parts } = this
    const adapter = this
    adapter.settled = []
    notice.set(null)
    const phrases: string[] = []
    const speechStart = new Set<() => void>()
    const speechEnd = new Set<(result: DictationAdapter.Result) => void>()
    const speech = new Set<(result: DictationAdapter.Result) => void>()
    let mic: Microphone | undefined
    let socket: Socket | undefined
    let ended = false
    let stopping = false
    let settle: (() => void) | undefined
    const unsent: ArrayBuffer[] = []

    const session: DictationAdapter.Session = {
      status: { type: "starting" },
      stop: () =>
        new Promise<void>((resolve) => {
          if (ended) return resolve()
          stopping = true
          mic?.stop()
          mic = undefined
          settle = resolve
          if (socket?.readyState === OPEN) socket.send(DICTATION_STOP)
          // The last words arrive before the socket closes; a relay that
          // never answers is closed from here.
          setTimeout(() => finish("stopped"), SETTLE_MS)
          if (!socket) finish("stopped")
        }),
      cancel: () => finish("cancelled"),
      onSpeechStart: (callback) => {
        speechStart.add(callback)
        return () => void speechStart.delete(callback)
      },
      onSpeechEnd: (callback) => {
        speechEnd.add(callback)
        return () => void speechEnd.delete(callback)
      },
      onSpeech: (callback) => {
        speech.add(callback)
        return () => void speech.delete(callback)
      },
    }

    function finish(reason: "stopped" | "cancelled" | "error", say?: string) {
      if (ended) return
      ended = true
      mic?.stop()
      mic = undefined
      try {
        socket?.close()
      } catch {
        // Already closed.
      }
      if (reason === "stopped") adapter.settled = phrases
      if (say) notice.set(say)
      session.status = { type: "ended", reason }
      for (const callback of speechEnd) {
        callback({ transcript: "", isFinal: true })
      }
      settle?.()
    }

    const fail = (say: string) => finish("error", say)

    void (async () => {
      if (!parts.supported()) return fail(NOTICES.unsupported)
      // The microphone first: a refusal costs no ticket and no model socket.
      try {
        mic = await parts.microphone((pcm) => {
          if (socket?.readyState === OPEN) socket.send(pcm)
          else if (unsent.length < 100) unsent.push(pcm)
        })
      } catch (error) {
        return fail(microphoneNotice(error))
      }
      if (ended) return mic.stop()
      try {
        const url = await parts.socket()
        if (ended) return
        if (!url) return fail(NOTICES.failed)
        const opened = parts.connect(url)
        opened.binaryType = "arraybuffer"
        socket = opened
        opened.addEventListener("message", (message) => {
          const read = DictationEvent.safeParse(
            parse((message as MessageEvent).data)
          )
          if (!read.success) return
          if (read.data.type === "error") return fail(NOTICES.dropped)
          const { text, type } = read.data
          if (type === "final") phrases.push(text)
          for (const callback of speech) {
            callback({ transcript: text, isFinal: type === "final" })
          }
        })
        opened.addEventListener("close", (event) => {
          if (ended) return
          const normal = stopping || (event as CloseEvent).code === 1000
          if (normal) finish("stopped")
          else fail(NOTICES.dropped)
        })
        opened.addEventListener("error", () =>
          fail(
            session.status.type === "running" ? NOTICES.dropped : NOTICES.failed
          )
        )
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("open")), OPEN_MS)
          opened.addEventListener("open", () => {
            clearTimeout(timer)
            resolve()
          })
        })
        if (ended) return
        for (const pcm of unsent.splice(0)) opened.send(pcm)
        session.status = { type: "running" }
        for (const callback of speechStart) callback()
      } catch {
        fail(NOTICES.failed)
      }
    })()

    return session
  }
}

/** The composer's dictation: one microphone, so one adapter. */
export const dictation = new RelayDictationAdapter()
