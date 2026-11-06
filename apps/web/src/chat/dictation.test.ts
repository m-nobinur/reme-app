// @vitest-environment happy-dom
import {
  type AssistantRuntime,
  AssistantRuntimeProvider,
  type DictationAdapter,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react"
import { DICTATION_STOP } from "@workspace/contracts"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

vi.mock("@/lib/api/server", () => ({ getDictationSocket: vi.fn() }))

const { NOTICES, RelayDictationAdapter, resampler } = await import(
  "./dictation"
)

/** A WebSocket the test drives: it records what it is sent and fires what it is told to. */
class FakeSocket {
  readyState = 0
  binaryType = ""
  sent: (string | ArrayBuffer)[] = []
  closes = 0
  private handlers: Record<string, ((event: unknown) => void)[]> = {}
  send = (data: string | ArrayBuffer) => void this.sent.push(data)
  close = () => {
    this.closes++
    this.readyState = 3
  }
  addEventListener = (type: string, handler: (event: unknown) => void) => {
    this.handlers[type] = [...(this.handlers[type] ?? []), handler]
  }
  fire(type: string, event: object = {}) {
    if (type === "open") this.readyState = 1
    for (const handler of this.handlers[type] ?? []) handler(event)
  }
  say(frame: object) {
    this.fire("message", { data: JSON.stringify(frame) })
  }
}

const pcm = (n: number) => new Int16Array([n]).buffer

type Setup = {
  socket: FakeSocket
  heard: DictationAdapter.Result[]
  ended: number
  mic: { onAudio: (chunk: ArrayBuffer) => void; stopped: number }
  session: DictationAdapter.Session
  adapter: InstanceType<typeof RelayDictationAdapter>
  ticket: ReturnType<typeof vi.fn>
  connect: ReturnType<typeof vi.fn>
}

/** A session started, with what it opened and what it was told. */
function build(
  over: {
    microphone?: () => Promise<never>
    ticket?: string | null
    supported?: boolean
  } = {}
): Setup {
  const socket = new FakeSocket()
  const mic = {
    onAudio: vi.fn() as (chunk: ArrayBuffer) => void,
    stopped: 0,
  }
  const ticket = vi.fn(async () =>
    over.ticket === undefined ? "wss://api.test/dictate?ticket=t" : over.ticket
  )
  const connect = vi.fn(() => socket)
  const adapter = new RelayDictationAdapter({
    socket: ticket,
    microphone:
      over.microphone ??
      (async (onAudio) => {
        mic.onAudio = onAudio
        return { stop: () => void mic.stopped++ }
      }),
    connect: connect as never,
    supported: () => over.supported ?? true,
  })
  const session = adapter.listen()
  const setup: Setup = {
    socket,
    heard: [],
    ended: 0,
    mic,
    session,
    adapter,
    ticket,
    connect,
  }
  session.onSpeech((result) => void setup.heard.push(result))
  session.onSpeechEnd(() => void setup.ended++)
  return setup
}

/** Until the session has either failed to start or is opening its socket. */
async function start(over: Parameters<typeof build>[0] = {}) {
  const setup = build(over)
  await vi.waitFor(() => expect(setup.session.status.type).not.toBe("starting"))
  return setup
}

/** The microphone open and the socket asked for, not yet open. */
async function startOpening() {
  const setup = build()
  await vi.waitFor(() => expect(setup.connect).toHaveBeenCalled())
  return setup
}

/** The socket open and the session running. */
async function running() {
  const setup = await startOpening()
  setup.socket.fire("open")
  await vi.waitFor(() => expect(setup.session.status.type).toBe("running"))
  return setup
}

beforeEach(() => {
  vi.useRealTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

it("shows what is being said as it is recognised, and commits each phrase when it settles", async () => {
  const { socket, heard } = await running()
  socket.say({ type: "partial", text: "book a" })
  socket.say({ type: "partial", text: "book a clean" })
  socket.say({ type: "final", text: "Book a clean." })
  socket.say({ type: "partial", text: "for" })
  expect(heard).toEqual([
    { transcript: "book a", isFinal: false },
    { transcript: "book a clean", isFinal: false },
    { transcript: "Book a clean.", isFinal: true },
    { transcript: "for", isFinal: false },
  ])
})

it("ignores a frame that is not the relay's", async () => {
  const { socket, heard } = await running()
  socket.fire("message", { data: "not json" })
  socket.fire("message", { data: new ArrayBuffer(2) })
  socket.say({ type: "partial" })
  socket.say({ type: "unknown", text: "x" })
  expect(heard).toEqual([])
})

it("holds the first audio until the socket is open, then sends it in order, and the rest as it comes", async () => {
  const setup = await startOpening()
  setup.mic.onAudio(pcm(1))
  setup.mic.onAudio(pcm(2))
  expect(setup.socket.sent).toEqual([])
  setup.socket.fire("open")
  await vi.waitFor(() => expect(setup.session.status.type).toBe("running"))
  expect(setup.socket.sent).toEqual([pcm(1), pcm(2)])
  setup.mic.onAudio(pcm(3))
  expect(setup.socket.sent).toEqual([pcm(1), pcm(2), pcm(3)])
  expect(setup.socket.binaryType).toBe("arraybuffer")
})

it("asks the microphone first, so a refusal costs no ticket and no socket", async () => {
  const denied = new DOMException("no", "NotAllowedError")
  const setup = await start({ microphone: async () => Promise.reject(denied) })
  expect(setup.session.status).toEqual({ type: "ended", reason: "error" })
  expect(setup.adapter.notice.text).toBe(NOTICES.denied)
  expect(setup.ticket).not.toHaveBeenCalled()
  expect(setup.connect).not.toHaveBeenCalled()
  expect(setup.ended).toBe(1)
})

it("says why in a few words: no microphone, one in use, no support", async () => {
  const noMic = await start({
    microphone: async () =>
      Promise.reject(new DOMException("", "NotFoundError")),
  })
  expect(noMic.adapter.notice.text).toBe(NOTICES.missing)
  const busy = await start({
    microphone: async () =>
      Promise.reject(new DOMException("", "NotReadableError")),
  })
  expect(busy.adapter.notice.text).toBe(NOTICES.busy)
  const unsupported = await start({ supported: false })
  expect(unsupported.adapter.notice.text).toBe(NOTICES.unsupported)
  expect(unsupported.session.status).toEqual({ type: "ended", reason: "error" })
})

it("ends with a notice when the api will not give a ticket", async () => {
  const setup = await start({ ticket: null })
  expect(setup.session.status).toEqual({ type: "ended", reason: "error" })
  expect(setup.adapter.notice.text).toBe(NOTICES.failed)
  expect(setup.mic.stopped).toBe(1)
  expect(setup.connect).not.toHaveBeenCalled()
})

it("ends with a notice when the socket will not open", async () => {
  const setup = await startOpening()
  setup.socket.fire("error")
  expect(setup.session.status).toEqual({ type: "ended", reason: "error" })
  expect(setup.adapter.notice.text).toBe(NOTICES.failed)
  expect(setup.mic.stopped).toBe(1)
})

it("ends with a notice when the socket never answers", async () => {
  vi.useFakeTimers()
  const socket = new FakeSocket()
  const adapter = new RelayDictationAdapter({
    socket: async () => "wss://api.test/dictate?ticket=t",
    microphone: async () => ({ stop: () => undefined }),
    connect: (() => socket) as never,
    supported: () => true,
  })
  const session = adapter.listen()
  await vi.advanceTimersByTimeAsync(9_000)
  expect(session.status).toEqual({ type: "ended", reason: "error" })
  expect(adapter.notice.text).toBe(NOTICES.failed)
})

it("says so when the socket drops mid-dictation, and ends", async () => {
  const setup = await running()
  setup.socket.fire("close", { code: 1006 })
  expect(setup.session.status).toEqual({ type: "ended", reason: "error" })
  expect(setup.adapter.notice.text).toBe(NOTICES.dropped)
  expect(setup.mic.stopped).toBe(1)
  expect(setup.ended).toBe(1)
})

it("says so when the relay reports a failure", async () => {
  const { socket, session, adapter } = await running()
  socket.say({ type: "error" })
  expect(session.status).toEqual({ type: "ended", reason: "error" })
  expect(adapter.notice.text).toBe(NOTICES.dropped)
})

it("stops on a tap: the microphone off, the relay told, the last words kept, and no notice", async () => {
  const setup = await running()
  const { socket, session } = setup
  const stopped = session.stop()
  expect(setup.mic.stopped).toBe(1)
  expect(socket.sent).toEqual([DICTATION_STOP])
  // The last phrase settles after the stop, before the socket closes.
  socket.say({ type: "final", text: "Thanks." })
  socket.fire("close", { code: 1000 })
  await stopped
  expect(setup.heard).toEqual([{ transcript: "Thanks.", isFinal: true }])
  expect(session.status).toEqual({ type: "ended", reason: "stopped" })
  expect(setup.adapter.notice.text).toBeNull()
})

it("closes the socket itself when the relay never settles", async () => {
  vi.useFakeTimers()
  const setup = await running()
  const stopped = setup.session.stop()
  await vi.advanceTimersByTimeAsync(3_100)
  await stopped
  expect(setup.socket.closes).toBe(1)
  expect(setup.session.status).toEqual({ type: "ended", reason: "stopped" })
})

it("treats the relay's own end of a long dictation as a stop, with no notice", async () => {
  const { socket, session, adapter } = await running()
  socket.fire("close", { code: 1000 })
  expect(session.status).toEqual({ type: "ended", reason: "stopped" })
  expect(adapter.notice.text).toBeNull()
})

it("cancels without a notice and without sending the stop", async () => {
  const setup = await running()
  setup.session.cancel()
  expect(setup.session.status).toEqual({ type: "ended", reason: "cancelled" })
  expect(setup.socket.closes).toBe(1)
  expect(setup.mic.stopped).toBe(1)
  expect(setup.socket.sent).not.toContain(DICTATION_STOP)
  expect(setup.adapter.notice.text).toBeNull()
})

it("clears the last notice when a new dictation starts", async () => {
  const adapter = new RelayDictationAdapter({
    socket: async () => null,
    microphone: async () => ({ stop: () => undefined }),
    connect: (() => new FakeSocket()) as never,
    supported: () => true,
  })
  adapter.listen()
  await vi.waitFor(() => expect(adapter.notice.text).toBe(NOTICES.failed))
  const seen: (string | null)[] = []
  adapter.notice.subscribe(() => seen.push(adapter.notice.text))
  adapter.listen()
  expect(seen[0]).toBeNull()
})

it("brings the microphone's rate to the model's, carrying what is left over between chunks", () => {
  const down = resampler(48_000)
  const first = down(new Float32Array(4800).fill(0.5))
  const second = down(new Float32Array(4801).fill(0.5))
  expect(first).toHaveLength(1600)
  expect(second).toHaveLength(1600)
  expect(
    [...first].every((sample) => sample === Math.trunc(0.5 * 0x7fff))
  ).toBe(true)
  // 44.1 kHz is not a whole number of samples to one: slots are two or three.
  const odd = resampler(44_100)
  expect(odd(new Float32Array(44_100))).toHaveLength(16_000)
  expect(resampler(16_000)(new Float32Array([1, -1, 2]))).toEqual(
    new Int16Array([0x7fff, -0x8000, 0x7fff])
  )
})

// The composer end: what assistant-ui does with the adapter's results.
;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

it("lands in the composer as assistant-ui's own dictation does: interim words replace each other, a final commits, typing is kept", async () => {
  const socket = new FakeSocket()
  const adapter = new RelayDictationAdapter({
    socket: async () => "wss://api.test/dictate?ticket=t",
    microphone: async () => ({ stop: () => undefined }),
    connect: (() => socket) as never,
    supported: () => true,
  })
  let runtime: AssistantRuntime | undefined
  const Probe = () => {
    runtime = useExternalStoreRuntime<ThreadMessageLike>({
      messages: [],
      convertMessage: (message: ThreadMessageLike) => message,
      onNew: async () => undefined,
      adapters: { dictation: adapter },
    })
    return createElement(AssistantRuntimeProvider, { runtime })
  }
  const root = createRoot(document.createElement("div"))
  await act(async () => root.render(createElement(Probe)))
  const composer = () => runtime?.thread.composer
  const text = () => composer()?.getState().text
  composer()?.setText("Hi Reme,")
  await act(async () => composer()?.startDictation())
  await vi.waitFor(() => expect(socket.readyState).toBe(0))
  await act(async () => socket.fire("open"))
  await act(async () => socket.say({ type: "partial", text: "book a" }))
  expect(text()).toBe("Hi Reme, book a")
  await act(async () => socket.say({ type: "partial", text: "book a clean" }))
  expect(text()).toBe("Hi Reme, book a clean")
  await act(async () => socket.say({ type: "final", text: "Book a clean." }))
  expect(text()).toBe("Hi Reme, Book a clean.")
  // Typing among the words keeps the typed text as the new start.
  composer()?.setText("Hi Reme, Book a clean. Friday")
  await act(async () => socket.say({ type: "partial", text: "morning" }))
  expect(text()).toBe("Hi Reme, Book a clean. Friday morning")
  await act(async () => socket.say({ type: "final", text: "Morning." }))
  expect(text()).toBe("Hi Reme, Book a clean. Friday Morning.")
  await act(async () => composer()?.stopDictation())
  await act(async () => socket.fire("close", { code: 1000 }))
  expect(composer()?.getState().dictation).toBeUndefined()
  expect(text()).toBe("Hi Reme, Book a clean. Friday Morning.")
  await act(async () => root.unmount())
})
