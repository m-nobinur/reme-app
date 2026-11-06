import { readFileSync } from "node:fs"
import { fileURLToPath, URL } from "node:url"
import {
  DICTATION_TIDY_MS,
  DICTATION_TIDY_PATH,
  ErrorEnvelope,
  needsTidy,
} from "@workspace/contracts"
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import worker from "../src/index.ts"
import {
  accepted,
  dictationTidy,
  SIDE_MODEL,
  SIDE_PROVIDERS,
  sideModel,
  TIDY_CACHE_KEY,
  TIDY_PROMPT,
  tidy,
} from "../src/tidy.ts"
import { env, stubJwksFetch } from "./sealed-session.ts"
import { CASES } from "./tidy-cases.ts"

/**
 * The tidy pass on stop (#749): the route's auth, minute and skip rule, the
 * timeout and the checks on what the model says, with a stand-in model. The
 * model itself is proved by `tidy-live.test.ts`.
 */

const realFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = stubJwksFetch()
})
afterAll(() => {
  globalThis.fetch = realFetch
})

const USER = "user_01TIDY"
const owner = { orgId: "org", session: { workosUserId: USER } } as Parameters<
  typeof dictationTidy
>[2]

const usage = {
  inputTokens: { total: 580, noCache: 68, cacheRead: 512, cacheWrite: 0 },
  outputTokens: { total: 28, text: 28, reasoning: 0 },
}

const answering = (text: string, seen: { prompt?: unknown }[] = []) =>
  new MockLanguageModelV4({
    doStream: async (options) => {
      seen.push({ prompt: options.prompt })
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: text },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage,
          },
        ] as never),
      }
    },
  })

describe("what the pass sends", () => {
  it("is the benchmark's prompt, the same bytes every call, with the words in transcript tags", async () => {
    for (const c of CASES) {
      const seen: { prompt?: unknown }[] = []
      const out = await tidy(answering(c.said, seen), c.input)
      expect(out, c.id).toBe(c.said)
      expect(c.check(out ?? ""), c.id).toBe(true)
      expect(needsTidy(c.input), c.id).toBe(true)
      expect(seen[0]?.prompt).toMatchObject([
        { role: "system", content: TIDY_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: `<transcript>${c.input}</transcript>` },
          ],
        },
      ])
    }
    expect(TIDY_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it("credits OpenWhispr's cleanup prompt", async () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/tidy.ts", import.meta.url)),
      "utf8"
    )
    expect(source).toContain("OpenWhispr")
  })

  it("pins the owner's hosts with no fallback, reasoning off and one cache key", async () => {
    expect(SIDE_MODEL).toBe("deepseek/deepseek-v4.1-flash-1017")
    expect(SIDE_PROVIDERS).toEqual([
      "relace/fast",
      "together",
      "wafer/us",
      "cohere",
    ])
    const bodies: Record<string, unknown>[] = []
    const realFetchHere = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response("{}", { status: 500 })
    }) as typeof fetch
    try {
      await tidy(sideModel("key"), "um hello there")
    } finally {
      globalThis.fetch = realFetchHere
    }
    expect(bodies[0]).toMatchObject({
      model: SIDE_MODEL,
      temperature: 0,
      reasoning: { enabled: false },
      prompt_cache_key: TIDY_CACHE_KEY,
      provider: { order: SIDE_PROVIDERS, allow_fallbacks: false },
    })
    const provider = bodies[0]?.provider as Record<string, unknown>
    expect(provider).not.toHaveProperty("quantizations")
    expect(provider).not.toHaveProperty("max_price")
  })
})

describe("what comes back", () => {
  it("is null for a model that fails, or that runs past the time", async () => {
    const broken = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("503")
      },
    })
    expect(await tidy(broken, "um hello")).toBeNull()
    const slow = new MockLanguageModelV4({
      doStream: ({ abortSignal }) =>
        new Promise((_, reject) =>
          abortSignal?.addEventListener("abort", () =>
            reject(abortSignal.reason)
          )
        ),
    })
    const began = Date.now()
    expect(await tidy(slow, "um hello", 30)).toBeNull()
    expect(Date.now() - began).toBeLessThan(1_000)
    expect(DICTATION_TIDY_MS).toBe(1_500)
  })

  it("is null for nothing, and for an answer that adds more than a time or a pound sign", () => {
    expect(accepted("um", "")).toBeNull()
    expect(accepted("um", "  \n")).toBeNull()
    expect(accepted("whats the price", "What's the price?")).toBe(
      "What's the price?"
    )
    expect(
      accepted(
        "whats the best price for a deep clean",
        "The best price for a deep clean in the UK is usually between £80 and £150 depending on the size of the property and its condition."
      )
    ).toBeNull()
  })
})

describe("the skip rule", () => {
  it("leaves a short message with no filler, correction or stutter as it was heard", () => {
    for (const text of [
      "Book a clean for Friday.",
      "Hi Reme, what's on today?",
      "I'd like a quote for the Patels.",
      "Send it to John at 3pm.",
    ]) {
      expect(needsTidy(text), text).toBe(false)
    }
  })

  it("tidies one with a filler, a correction, a stutter, or a long one", () => {
    for (const text of [
      "um book a clean",
      "Book it, like, for Friday",
      "book it for thursday no wait friday",
      "make it fifty actually",
      "send the the invoice",
      "scratch that",
      "one two three four five six seven eight nine ten eleven twelve thirteen",
    ]) {
      expect(needsTidy(text), text).toBe(true)
    }
  })
})

describe("POST /dictation/tidy", () => {
  const asked: string[] = []
  const keys: string[] = []
  let allowed = true
  beforeEach(() => {
    asked.length = 0
    keys.length = 0
    allowed = true
  })
  const bindings = (apiKey: string | undefined = "or-key") =>
    ({
      OPENROUTER_API_KEY: apiKey,
      DICTATION_LIMIT: {
        limit: async ({ key }: { key: string }) => {
          keys.push(key)
          return { success: allowed }
        },
      },
    }) as unknown as Parameters<typeof dictationTidy>[1]
  const model = (text: string) => () => {
    asked.push("model")
    return answering(text)
  }
  const post = (body: unknown, method = "POST", path = DICTATION_TIDY_PATH) =>
    new Request(`http://api.invalid${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify(body) : undefined,
    })
  const answer = async (response: Response | null) =>
    (await (response as Response).json()) as { text: string | null }

  it("is the owner's: no session, no answer", async () => {
    const response = await worker.fetch(
      post({ text: "um hello" }),
      env("postgresql://127.0.0.1:1/none") as unknown as Env,
      { waitUntil: () => undefined } as unknown as ExecutionContext
    )
    expect(response.status).toBe(401)
  })

  it("answers a POST to its own path only", async () => {
    expect(
      await dictationTidy(post(null, "GET"), bindings(), owner, model("x"))
    ).toBeNull()
    expect(
      await dictationTidy(
        post({}, "POST", "/dictation/other"),
        bindings(),
        owner,
        model("x")
      )
    ).toBeNull()
  })

  it("refuses a body that is not the contract's", async () => {
    for (const body of [
      null,
      {},
      { text: "" },
      { text: 3 },
      { text: "x".repeat(8_001) },
      { text: "um", more: 1 },
    ]) {
      const response = await dictationTidy(
        post(body),
        bindings(),
        owner,
        model("x")
      )
      expect(response?.status, JSON.stringify(body).slice(0, 40)).toBe(400)
    }
    expect(asked).toEqual([])
    expect(keys).toEqual([])
  })

  it("counts each pass against the person's minute under a key of its own, and refuses past it", async () => {
    allowed = false
    const response = await dictationTidy(
      post({ text: "um hello" }),
      bindings(),
      owner,
      model("Hello.")
    )
    expect(response?.status).toBe(429)
    expect(response?.headers.get("retry-after")).toBe("60")
    expect(ErrorEnvelope.parse(await response?.json()).code).toBe(
      "rate.limited"
    )
    expect(keys).toEqual([`tidy:${USER}`])
    expect(asked).toEqual([])
  })

  it("makes no model call for a message the skip rule leaves, or with no key", async () => {
    const skipped = await dictationTidy(
      post({ text: "Book a clean for Friday." }),
      bindings(),
      owner,
      model("x")
    )
    expect(await answer(skipped)).toEqual({ text: null })
    const keyless = await dictationTidy(
      post({ text: "um hello" }),
      bindings(""),
      owner,
      model("x")
    )
    expect(await answer(keyless)).toEqual({ text: null })
    expect(asked).toEqual([])
  })

  it("answers the tidied text for a message that needs it", async () => {
    const c = CASES[1] as (typeof CASES)[number]
    const response = await dictationTidy(
      post({ text: c.input }),
      bindings(),
      owner,
      model(c.said)
    )
    expect(response?.status).toBe(200)
    expect(await answer(response)).toEqual({ text: c.said })
    expect(asked).toEqual(["model"])
  })

  it("answers null, not an error, when the model fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const failing = () =>
      new MockLanguageModelV4({
        doStream: async () => {
          throw new Error("503")
        },
      })
    const response = await dictationTidy(
      post({ text: "um hello" }),
      bindings(),
      owner,
      failing
    )
    expect(response?.status).toBe(200)
    expect(await answer(response)).toEqual({ text: null })
    vi.restoreAllMocks()
  })

  it("logs the host, tokens, cached tokens, time and cost of a call", async () => {
    const lines: string[] = []
    vi.spyOn(console, "log").mockImplementation(
      (line: string) => void lines.push(line)
    )
    await tidy(answering("Hello."), "um hello")
    vi.restoreAllMocks()
    const logged = JSON.parse(lines[0] ?? "{}")
    expect(logged).toMatchObject({
      code: "dictation.tidy",
      input_tokens: 580,
      cached_tokens: 512,
      output_tokens: 28,
    })
    expect(logged).toHaveProperty("ms")
    expect(logged).toHaveProperty("provider")
    expect(logged).toHaveProperty("cost_usd")
  })
})
