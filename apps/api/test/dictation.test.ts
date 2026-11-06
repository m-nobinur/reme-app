import { readFileSync } from "node:fs"
import { fileURLToPath, URL } from "node:url"
import {
  DICTATION_MAX_SECONDS,
  DICTATION_PATH,
  DICTATION_STOP,
  DICTATION_TICKET_PATH,
  DICTATION_TICKET_SECONDS,
  DICTATIONS_PER_MINUTE,
  ErrorEnvelope,
} from "@workspace/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  dictate,
  dictationTicket,
  eventOf,
  mintTicket,
  readTicket,
  relay,
  type Socket,
} from "../src/dictation.ts"
import worker from "../src/index.ts"
import { COOKIE_PASSWORD, env, stubJwksFetch } from "./sealed-session.ts"

/**
 * Voice dictation: the ticket that opens a socket, the refusals before the
 * upgrade, and the relay between the browser's socket and the model's, each
 * end a stand-in. The model itself is proved by `dictation-live.test.ts`.
 */

const realFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = stubJwksFetch()
})
afterAll(() => {
  globalThis.fetch = realFetch
})

const USER = "user_01DICTATION"
const WEB = "https://staging.remeai.co.uk"

describe("the ticket", () => {
  it("names the user it was minted for, for a minute", async () => {
    const now = Date.now()
    const ticket = await mintTicket(COOKIE_PASSWORD, USER, now)
    expect(await readTicket(COOKIE_PASSWORD, ticket, now)).toBe(USER)
    expect(
      await readTicket(
        COOKIE_PASSWORD,
        ticket,
        now + (DICTATION_TICKET_SECONDS - 1) * 1000
      )
    ).toBe(USER)
    expect(
      await readTicket(
        COOKIE_PASSWORD,
        ticket,
        now + (DICTATION_TICKET_SECONDS + 1) * 1000
      )
    ).toBeNull()
  })

  it("is refused when forged, altered or made under another key", async () => {
    const ticket = await mintTicket(COOKIE_PASSWORD, USER)
    const [expiry, , mac] = ticket.split(".")
    for (const bad of [
      null,
      "",
      "nonsense",
      "1.2.3",
      ticket.replace(USER, "user_01OTHER"),
      `${Number(expiry) + 600}.${USER}.${mac}`,
      `${expiry}.${USER}.${"0".repeat(64)}`,
    ]) {
      expect(await readTicket(COOKIE_PASSWORD, bad), String(bad)).toBeNull()
    }
    expect(await readTicket("z".repeat(32), ticket)).toBeNull()
  })

  it("is minted only for a signed-in session", async () => {
    const response = await worker.fetch(
      new Request(`http://api.invalid${DICTATION_TICKET_PATH}`, {
        method: "POST",
      }),
      env("postgresql://127.0.0.1:1/none") as unknown as Env,
      { waitUntil: () => undefined } as unknown as ExecutionContext
    )
    expect(response.status).toBe(401)
  })

  it("is the owner's, answered for a POST only", async () => {
    const owner = {
      orgId: "org",
      session: { workosUserId: USER },
    } as Parameters<typeof dictationTicket>[2]
    const given = { WORKOS_COOKIE_PASSWORD: COOKIE_PASSWORD }
    const minted = await dictationTicket(
      new Request(`http://api.invalid${DICTATION_TICKET_PATH}`, {
        method: "POST",
      }),
      given,
      owner
    )
    expect(minted?.status).toBe(201)
    const { ticket } = (await (minted as Response).json()) as {
      ticket: string
    }
    expect(await readTicket(COOKIE_PASSWORD, ticket)).toBe(USER)
    expect(
      await dictationTicket(
        new Request(`http://api.invalid${DICTATION_TICKET_PATH}`),
        given,
        owner
      )
    ).toBeNull()
  })
})

describe("the socket's refusals, before any upgrade", () => {
  beforeEach(() => {
    keys.length = 0
    asked.length = 0
  })
  const keys: string[] = []
  let allowed = true
  const asked: string[] = []
  const bindings = {
    WEB_ORIGIN: WEB,
    WORKOS_COOKIE_PASSWORD: COOKIE_PASSWORD,
    DICTATION_LIMIT: {
      limit: async ({ key }: { key: string }) => {
        keys.push(key)
        return { success: allowed }
      },
    },
    AI: {
      run: async (model: string) => {
        asked.push(model)
        return new Response(null)
      },
    },
  } as unknown as Parameters<typeof dictate>[1]

  const open = async (
    ticket: string | null,
    headers: Record<string, string> = {
      upgrade: "websocket",
      origin: WEB,
    },
    host = "api.invalid"
  ) =>
    dictate(
      new Request(
        `https://${host}${DICTATION_PATH}${ticket ? `?ticket=${ticket}` : ""}`,
        { headers }
      ),
      bindings
    )

  const code = async (response: Response) =>
    ErrorEnvelope.parse(await response.json()).code

  it("wants an upgrade, a page of ours and a good ticket", async () => {
    const ticket = await mintTicket(COOKIE_PASSWORD, USER)
    const plain = await open(ticket, { origin: WEB })
    expect(plain.status).toBe(426)
    const foreign = await open(ticket, {
      upgrade: "websocket",
      origin: "https://evil.example",
    })
    expect(foreign.status).toBe(403)
    expect(await code(foreign)).toBe("dictation.origin")
    const none = await open(null)
    expect(none.status).toBe(401)
    expect(await code(none)).toBe("dictation.ticket")
    expect((await open("1.2.3")).status).toBe(401)
    expect(keys).toEqual([])
    expect(asked).toEqual([])
  })

  it("lets a local page reach a local api, and no other host", async () => {
    const ticket = await mintTicket(COOKIE_PASSWORD, USER)
    const headers = { upgrade: "websocket", origin: "http://localhost:3000" }
    expect((await open(ticket, headers, "api.invalid")).status).toBe(403)
    // Past the origin check, the stand-in model gives no socket: 503, not 403.
    expect((await open(ticket, headers, "localhost:8787")).status).toBe(503)
  })

  it("counts each start against the person, and refuses the next over the minute", async () => {
    const ticket = await mintTicket(COOKIE_PASSWORD, USER)
    allowed = false
    const limited = await open(ticket)
    allowed = true
    expect(limited.status).toBe(429)
    expect(limited.headers.get("retry-after")).toBe("60")
    expect(await code(limited)).toBe("rate.limited")
    expect(keys.at(-1)).toBe(`dictation:${USER}`)
    expect(asked).toEqual([])
  })

  it("refuses the upgrade when the model gives no socket", async () => {
    const response = await open(await mintTicket(COOKIE_PASSWORD, USER))
    expect(response.status).toBe(503)
    expect(await code(response)).toBe("dictation.unavailable")
    expect(asked).toEqual(["@cf/deepgram/nova-3"])
  })

  it("refuses it when the model's call throws", async () => {
    const throwing = {
      ...bindings,
      AI: {
        run: async () => {
          throw new Error("no capacity")
        },
      },
    } as unknown as Parameters<typeof dictate>[1]
    const response = await dictate(
      new Request(
        `https://api.invalid${DICTATION_PATH}?ticket=${await mintTicket(COOKIE_PASSWORD, USER)}`,
        { headers: { upgrade: "websocket", origin: WEB } }
      ),
      throwing
    )
    expect(response.status).toBe(503)
  })
})

describe("what Deepgram says, as the browser reads it", () => {
  const frame = (transcript: string, is_final: boolean) =>
    JSON.stringify({
      type: "Results",
      is_final,
      channel: { alternatives: [{ transcript }] },
    })

  it("turns a result into the phrase so far, or the phrase settled", () => {
    expect(eventOf(frame("Hello there", false))).toEqual({
      type: "partial",
      text: "Hello there",
    })
    expect(eventOf(frame(" Hello there. ", true))).toEqual({
      type: "final",
      text: "Hello there.",
    })
  })

  it("drops silence, metadata and anything that is not a result", () => {
    expect(eventOf(frame("", false))).toBeNull()
    expect(eventOf(frame("   ", true))).toBeNull()
    expect(eventOf(JSON.stringify({ type: "Metadata" }))).toBeNull()
    expect(eventOf(JSON.stringify({ type: "SpeechStarted" }))).toBeNull()
    expect(eventOf("not json")).toBeNull()
    expect(eventOf(new ArrayBuffer(4))).toBeNull()
  })
})

/** A socket that records what it is sent and lets a test fire what it receives. */
function fake() {
  const sent: (string | ArrayBuffer)[] = []
  const closed: { code?: number }[] = []
  const handlers: Record<string, ((event: unknown) => void)[]> = {}
  const socket: Socket = {
    send: (data) => void sent.push(data as string | ArrayBuffer),
    close: (code) => void closed.push({ code }),
    addEventListener: ((type: string, handler: (event: unknown) => void) => {
      handlers[type] = [...(handlers[type] ?? []), handler]
    }) as Socket["addEventListener"],
  }
  return {
    socket,
    sent,
    closed,
    fire: (type: string, data?: unknown) => {
      for (const handler of handlers[type] ?? []) handler({ data })
    },
  }
}

describe("the relay", () => {
  const setup = () => {
    const browser = fake()
    const model = fake()
    const timers: (() => void)[] = []
    let cancelled = 0
    relay(browser.socket, model.socket, (_ms, run) => {
      timers.push(run)
      return () => void cancelled++
    })
    return { browser, model, timers, cancelled: () => cancelled }
  }
  const audio = (bytes: number) => new ArrayBuffer(bytes)

  it("sends the microphone's audio up as it comes", () => {
    const { browser, model } = setup()
    const chunk = audio(640)
    browser.fire("message", chunk)
    expect(model.sent).toEqual([chunk])
  })

  it("sends the model's results down as phrases", () => {
    const { browser, model } = setup()
    model.fire(
      "message",
      JSON.stringify({
        type: "Results",
        is_final: false,
        channel: { alternatives: [{ transcript: "book a" }] },
      })
    )
    model.fire(
      "message",
      JSON.stringify({
        type: "Results",
        is_final: true,
        channel: { alternatives: [{ transcript: "Book a clean." }] },
      })
    )
    model.fire("message", JSON.stringify({ type: "Metadata" }))
    expect(browser.sent.map((frame) => JSON.parse(String(frame)))).toEqual([
      { type: "partial", text: "book a" },
      { type: "final", text: "Book a clean." },
    ])
  })

  it("turns the browser's stop into Deepgram's CloseStream, once, and sends no more audio", () => {
    const { browser, model } = setup()
    browser.fire("message", DICTATION_STOP)
    browser.fire("message", DICTATION_STOP)
    browser.fire("message", audio(8))
    expect(model.sent).toEqual([JSON.stringify({ type: "CloseStream" })])
  })

  it("ignores any other text the browser sends", () => {
    const { browser, model } = setup()
    browser.fire("message", JSON.stringify({ type: "KeepAlive" }))
    browser.fire("message", "not json")
    browser.fire("message", JSON.stringify({ type: "stop", extra: 1 }))
    expect(model.sent).toEqual([])
  })

  it("ends the browser's socket when the model's ends, and the model's when the browser's does", () => {
    const first = setup()
    first.model.fire("close")
    expect(first.browser.closed).toEqual([{ code: 1000 }])
    const second = setup()
    second.browser.fire("close")
    expect(second.model.closed).toHaveLength(1)
    expect(second.cancelled()).toBe(1)
  })

  it("tells the browser when either socket fails, and closes both", () => {
    const { browser, model } = setup()
    model.fire("error")
    expect(browser.sent.map((frame) => JSON.parse(String(frame)))).toEqual([
      { type: "error" },
    ])
    expect(browser.closed).toEqual([{ code: 1011 }])
    expect(model.closed).toHaveLength(1)
  })

  it(`stops a dictation at ${DICTATION_MAX_SECONDS} seconds, as the owner's stop would`, () => {
    const { model, timers } = setup()
    expect(timers).toHaveLength(1)
    timers[0]?.()
    expect(model.sent).toEqual([JSON.stringify({ type: "CloseStream" })])
  })

  it("stops one that sends more audio than the cap holds", () => {
    const { browser, model } = setup()
    browser.fire("message", audio(6 * 1024 * 1024))
    browser.fire("message", audio(6 * 1024 * 1024))
    expect(model.sent).toHaveLength(2)
    expect(model.sent[0]).toHaveProperty("byteLength", 6 * 1024 * 1024)
    expect(model.sent[1]).toBe(JSON.stringify({ type: "CloseStream" }))
  })
})

describe("the Worker is configured for dictation", () => {
  type Config = {
    ai?: { binding: string }
    ratelimits?: {
      name: string
      namespace_id: string
      simple: { limit: number; period: number }
    }[]
    env: { production: Config }
  }
  const config = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
      "utf8"
    ).replace(/^\s*\/\/.*$/gm, "")
  ) as Config
  const blocks = [config, config.env.production]
  const limits = blocks.map((block) =>
    block.ratelimits?.find((entry) => entry.name === "DICTATION_LIMIT")
  )

  it("binds Workers AI in both blocks, since bindings do not inherit", () => {
    for (const block of blocks) expect(block.ai?.binding).toBe("AI")
  })

  it("declares the limit in both, in a namespace of its own, at the contract's number", () => {
    for (const limit of limits) {
      expect(limit?.simple).toEqual({
        limit: DICTATIONS_PER_MINUTE,
        period: 60,
      })
    }
    const everyNamespace = blocks.flatMap((block) =>
      (block.ratelimits ?? []).map((entry) => entry.namespace_id)
    )
    expect(new Set(everyNamespace).size).toBe(everyNamespace.length)
    expect(["1001", "1002"]).not.toContain(limits[0]?.namespace_id)
  })
})
