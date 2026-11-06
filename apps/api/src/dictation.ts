import {
  DICTATION_MAX_SECONDS,
  DICTATION_SAMPLE_RATE,
  DICTATION_TICKET_PATH,
  DICTATION_TICKET_SECONDS,
  DictationControl,
  type DictationEvent,
  type DictationTicket,
} from "@workspace/contracts"
import type { Owner } from "./changes.ts"
import { failure } from "./http.ts"

/**
 * Voice dictation: the browser's microphone, relayed to Deepgram Nova-3 on
 * Workers AI over a WebSocket, so no provider key reaches the browser.
 *
 * The socket is opened on this Worker's own host, where the web session's
 * cookie does not go. An owner's session mints a ticket first
 * (`POST /dictation/ticket`, an `ownerRoute`), a 60 second HMAC over the WorkOS
 * user, and the socket carries it in its query. The ticket proves the session
 * was there a moment ago; the rate limit and the length cap bound what a
 * leaked one can spend.
 *
 * Another provider (ElevenLabs Scribe v2 Realtime is the one considered) is a
 * change to `openUpstream` and `eventOf` alone: the wire to the browser is
 * `DictationEvent` either way.
 */

export const NOVA_3 = "@cf/deepgram/nova-3"

/** Workers AI's string-valued form of Deepgram's streaming options, as its own `WorkersAINova3STT` sends them (agents 0.33.0). */
export const NOVA_3_INPUT = {
  encoding: "linear16",
  sample_rate: String(DICTATION_SAMPLE_RATE),
  language: "en-GB",
  interim_results: "true",
  punctuate: "true",
  smart_format: "true",
  endpointing: "300",
}

const PURPOSE = "reme.dictation-ticket.v1"

/** 10 MB, a little over `DICTATION_MAX_SECONDS` of 16 kHz 16-bit mono. */
const MAX_AUDIO_BYTES = 10 * 1024 * 1024

const key = (secret: string) =>
  crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`${PURPOSE}:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  )

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("")

/** `<expiry seconds>.<WorkOS user>.<MAC over both>`. */
export async function mintTicket(
  secret: string,
  workosUserId: string,
  now = Date.now()
): Promise<string> {
  const body = `${Math.floor(now / 1000) + DICTATION_TICKET_SECONDS}.${workosUserId}`
  const mac = await crypto.subtle.sign(
    "HMAC",
    await key(secret),
    new TextEncoder().encode(body)
  )
  return `${body}.${hex(mac)}`
}

/** The WorkOS user a ticket was minted for, or null for one that is forged, altered or past its minute. */
export async function readTicket(
  secret: string,
  ticket: string | null,
  now = Date.now()
): Promise<string | null> {
  const parts = ticket?.split(".") ?? []
  const expiry = Number(parts[0])
  const given = parts.at(-1) ?? ""
  if (parts.length < 3 || !Number.isFinite(expiry) || expiry * 1000 < now) {
    return null
  }
  if (!/^[0-9a-f]{64}$/.test(given)) return null
  const body = parts.slice(0, -1).join(".")
  const valid = await crypto.subtle.verify(
    "HMAC",
    await key(secret),
    Uint8Array.from(given.match(/../g) ?? [], (h) => Number.parseInt(h, 16)),
    new TextEncoder().encode(body)
  )
  return valid ? parts.slice(1, -1).join(".") : null
}

/** `POST /dictation/ticket`: the owner's session, for a socket to `GET /dictate`. */
export async function dictationTicket(
  request: Request,
  env: Pick<Env, "WORKOS_COOKIE_PASSWORD">,
  owner: Owner
): Promise<Response | null> {
  if (
    new URL(request.url).pathname !== DICTATION_TICKET_PATH ||
    request.method !== "POST"
  ) {
    return null
  }
  const body: DictationTicket = {
    ticket: await mintTicket(
      env.WORKOS_COOKIE_PASSWORD,
      owner.session.workosUserId
    ),
  }
  return Response.json(body, { status: 201 })
}

/** The speech model's socket, or null when Workers AI will not open one. */
async function openUpstream(env: Pick<Env, "AI">): Promise<WebSocket | null> {
  const upstream = await env.AI.run(NOVA_3, NOVA_3_INPUT as never, {
    websocket: true,
  })
  return (upstream as Response).webSocket ?? null
}

/**
 * What Deepgram's frame says, as the browser reads it: the phrase so far, or
 * the phrase settled. Its other frames (metadata, speech started) are not
 * the browser's business.
 */
export function eventOf(data: unknown): DictationEvent | null {
  if (typeof data !== "string") return null
  let frame: {
    type?: string
    is_final?: boolean
    channel?: { alternatives?: { transcript?: string }[] }
  }
  try {
    frame = JSON.parse(data)
  } catch {
    return null
  }
  if (frame.type !== "Results") return null
  const text = frame.channel?.alternatives?.[0]?.transcript?.trim()
  if (!text) return null
  return { type: frame.is_final ? "final" : "partial", text }
}

/** The part of a WebSocket the relay uses, so a test can stand in for either end. */
export type Socket = Pick<WebSocket, "send" | "close" | "addEventListener">

/**
 * Joins the browser's socket to the model's. Audio goes up as it comes; the
 * browser's `stop` becomes Deepgram's `CloseStream`, which settles what was
 * heard and closes. A dictation that runs past `DICTATION_MAX_SECONDS`, or
 * sends more audio than that holds, is stopped the same way.
 */
export function relay(
  browser: Socket,
  upstream: Socket,
  after: (ms: number, run: () => void) => () => void = (ms, run) => {
    const timer = setTimeout(run, ms)
    return () => clearTimeout(timer)
  }
) {
  let bytes = 0
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    upstream.send(JSON.stringify({ type: "CloseStream" }))
  }
  const cancel = after(DICTATION_MAX_SECONDS * 1000, stop)
  const fail = () => {
    cancel()
    const event: DictationEvent = { type: "error" }
    try {
      browser.send(JSON.stringify(event))
      browser.close(1011, "dictation failed")
    } catch {
      // The browser's socket is already gone; the model's still closes.
    }
    upstream.close()
  }

  browser.addEventListener("message", (message) => {
    const { data } = message as MessageEvent
    if (typeof data === "string") {
      if (DictationControl.safeParse(safeJson(data)).success) stop()
      return
    }
    bytes += (data as ArrayBuffer).byteLength
    if (bytes > MAX_AUDIO_BYTES) return stop()
    if (!stopped) upstream.send(data as ArrayBuffer)
  })
  browser.addEventListener("close", () => {
    cancel()
    upstream.close()
  })
  browser.addEventListener("error", fail)

  upstream.addEventListener("message", (message) => {
    const event = eventOf((message as MessageEvent).data)
    if (event) browser.send(JSON.stringify(event))
  })
  upstream.addEventListener("close", () => {
    cancel()
    browser.close(1000, "done")
  })
  upstream.addEventListener("error", fail)
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const refused = (status: number, code: string, message: string) =>
  failure(status, {
    class: status === 429 ? "transient" : "permission",
    code,
    message,
    detail: {},
  })

/** Where the browser's page may be, for a socket's `Origin`: the web app, or a local one beside a local api. */
const originAllowed = (request: Request, webOrigin: string) => {
  const origin = request.headers.get("origin")
  if (origin === webOrigin) return true
  const local = (host: string) => host === "localhost" || host === "127.0.0.1"
  return (
    origin !== null &&
    local(new URL(request.url).hostname) &&
    local(new URL(origin).hostname)
  )
}

/**
 * `GET /dictate?ticket=…` as a WebSocket upgrade. Refused before the upgrade
 * for a page that is not ours, a ticket that is not good and a person over
 * their dictations for the minute; the model's socket is open before the
 * browser's is accepted, so a model that will not answer is a refused upgrade.
 */
export async function dictate(
  request: Request,
  env: Pick<
    Env,
    "AI" | "DICTATION_LIMIT" | "WEB_ORIGIN" | "WORKOS_COOKIE_PASSWORD"
  >
): Promise<Response> {
  if (request.headers.get("upgrade") !== "websocket") {
    return refused(426, "dictation.upgrade_required", "This is a WebSocket.")
  }
  if (!originAllowed(request, env.WEB_ORIGIN)) {
    return refused(403, "dictation.origin", "Not from this page.")
  }
  const user = await readTicket(
    env.WORKOS_COOKIE_PASSWORD,
    new URL(request.url).searchParams.get("ticket")
  )
  if (!user) {
    return refused(401, "dictation.ticket", "This ticket is not good.")
  }
  const { success } = await env.DICTATION_LIMIT.limit({
    key: `dictation:${user}`,
  })
  if (!success) {
    const limited = refused(
      429,
      "rate.limited",
      "Too many dictations in a short time. Wait a minute and try again."
    )
    limited.headers.set("retry-after", "60")
    return limited
  }
  const upstream = await openUpstream(env).catch(() => null)
  if (!upstream) {
    return failure(503, {
      class: "transient",
      code: "dictation.unavailable",
      message: "Dictation is not available right now.",
      detail: {},
    })
  }
  const { 0: client, 1: server } = new WebSocketPair()
  server.accept()
  upstream.accept()
  relay(server, upstream)
  return new Response(null, { status: 101, webSocket: client })
}
