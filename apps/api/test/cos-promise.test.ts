import { streamText, tool } from "ai"
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { contextOf } from "../src/cos/agent.ts"
import {
  type Check,
  CLAIMS_NOTE,
  claimsGate,
  gated,
  MAX_RERUNS,
  NUDGE,
  type Prompt,
  promiseGate,
} from "../src/cos/promise.ts"

/**
 * The promise gate with a model stood in for by `MockLanguageModelV4`: a step
 * that ends on text alone is run again inside the same step when the reading
 * says it promised work, at most twice, and a tool call from the re-run goes
 * through the SDK as any other.
 */

type Part = Record<string, unknown> & { type: string }

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
})

const said = (text: string): Part[] => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "0" },
  { type: "text-delta", id: "0", delta: text },
  { type: "text-end", id: "0" },
  {
    type: "finish",
    finishReason: { unified: "stop", raw: "stop" },
    usage: usage(100, 10),
  },
]

const called: Part[] = [
  { type: "stream-start", warnings: [] },
  {
    type: "tool-call",
    toolCallId: "c1",
    toolName: "set_up",
    input: "{}",
  },
  {
    type: "finish",
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
    usage: usage(100, 10),
  },
]

/** A model that answers each call with the next step (the last one again when they run out). */
function scripted(...steps: Part[][]) {
  const prompts: unknown[] = []
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      prompts.push(prompt)
      const step = steps[Math.min(prompts.length, steps.length) - 1] as Part[]
      return { stream: convertArrayToReadableStream(step) as never }
    },
  })
  return { model, prompts }
}

const run = (
  model: MockLanguageModelV4,
  promised: (said: string) => Promise<boolean>,
  claims: Check[] = []
) => {
  let ran = 0
  const result = streamText({
    model: gated(model, [promiseGate(promised), ...claims]),
    prompt: "Set it up",
    tools: {
      set_up: tool({
        description: "Sets it up",
        inputSchema: z.object({}),
        execute: async () => {
          ran++
          return "done"
        },
      }),
    },
    stopWhen: ({ steps }) => steps.length >= 3,
  })
  const done = result.consumeStream().then(() => result.steps)
  return { done, ran: () => ran }
}

describe("the promise gate", () => {
  it("runs a promise with no tool call again, and the tool the re-run calls runs", async () => {
    const { model, prompts } = scripted(
      said("I'll set that up now."),
      called,
      said("Done.")
    )
    const { done, ran } = run(model, async () => true)
    const steps = await done
    expect(ran()).toBe(1)
    // The re-run was sent the promise and the nudge; the next step was not.
    const rerun = prompts[1] as { role: string; content: { text: string }[] }[]
    expect(rerun.slice(-2).map((m) => [m.role, m.content[0]?.text])).toEqual([
      ["assistant", "I'll set that up now."],
      ["user", NUDGE],
    ])
    // One step held the promise and the call, and its usage is both calls'.
    expect(steps[0]?.text).toBe("I'll set that up now.")
    expect(steps[0]?.toolCalls).toHaveLength(1)
    expect(steps[0]?.usage.inputTokens).toBe(200)
    expect(steps).toHaveLength(2)
  })

  it("keeps a re-run's streamed tool input on the call it becomes", async () => {
    const streamed: Part[] = [
      { type: "stream-start", warnings: [] },
      { type: "tool-input-start", id: "c1", toolName: "set_up" },
      { type: "tool-input-delta", id: "c1", delta: "{}" },
      { type: "tool-input-end", id: "c1" },
      ...called.slice(1),
    ]
    const { model } = scripted(
      said("I'll set that up now."),
      streamed,
      said("Done.")
    )
    const result = streamText({
      model: gated(model, [promiseGate(async () => true)]),
      prompt: "Set it up",
      tools: {
        set_up: tool({
          description: "Sets it up",
          inputSchema: z.object({}),
          execute: async () => "done",
        }),
      },
      stopWhen: ({ steps }) => steps.length >= 3,
    })
    const ids = new Set<string>()
    for await (const chunk of result.toUIMessageStream()) {
      if ("toolCallId" in chunk) ids.add(chunk.toolCallId)
    }
    expect([...ids]).toEqual(["c1"])
  })

  it("runs a model that keeps promising at most twice more, then lets the turn end", async () => {
    const { model, prompts } = scripted(said("I'll do it."))
    const { done, ran } = run(model, async () => true)
    const steps = await done
    expect(prompts).toHaveLength(1 + MAX_RERUNS)
    expect(steps).toHaveLength(1)
    expect(ran()).toBe(0)
  })

  it("leaves an honest ending, a tool call and a reading that fails as they are", async () => {
    for (const promised of [
      async () => false,
      async () => {
        throw new Error("jev is down")
      },
    ]) {
      const { model, prompts } = scripted(said("Your site is live."))
      await run(model, promised).done
      expect(prompts).toHaveLength(1)
    }
    const { model, prompts } = scripted(called, said("Done."))
    // A step that called a tool is never read, only the text-only one after it.
    const asked: string[] = []
    await run(model, async (text) => {
      asked.push(text)
      return false
    }).done
    expect(prompts).toHaveLength(2)
    expect(asked).toEqual(["Done."])
  })
})

/**
 * The claims gate reads the closing text against what the turn was shown:
 * the owner's messages and context, and the tool results, whose evidence
 * counts only since the owner's latest message. The instructions back
 * nothing, so a figure in them is no fact.
 */
const PRICES = "Facts: business.prices: Regular clean £60, deep clean £180"

type Result = { before?: boolean; tool?: string; value: unknown }

const shown = (context: string, ...results: Result[]): Prompt => {
  const exchange = ({ tool: name = "t", value }: Result, i: number) => [
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: `c${i}`, toolName: name, input: {} },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `c${i}`,
          toolName: name,
          output: { type: "json", value },
        },
      ],
    },
  ]
  return [
    { role: "system", content: "You are the Chief of Staff. A clean is £99." },
    ...results.flatMap((r, i) => (r.before ? exchange(r, i) : [])),
    { role: "user", content: [{ type: "text", text: context }] },
    { role: "user", content: [{ type: "text", text: "Go on then" }] },
    ...results.flatMap((r, i) => (r.before ? [] : exchange(r, i))),
  ] as Prompt
}

/** A context whose workspace block holds `labels`, as `contextOf` writes it. */
const withWorkspace = (labels: object, facts = "") =>
  `Mode: ask.\n${facts}\n<data source="workspace" taint="none">\n${JSON.stringify(labels)}\n</data>`

const UNPUBLISHED = { site: { address: "tidy.reme.site", live: false } }
const PUBLISHED = { site: { address: "tidy.reme.site", live: true } }

const SET = {
  outcome: "created",
  evidence: [{ kind: "job", runs_at: "2026-10-31T08:00:00.000Z" }],
}

/** A Jev stand-in that answers `yes` and counts the times it was asked. */
const jev = (yes: boolean | Error) => {
  const asked: string[] = []
  const unsure = async (reply: string) => {
    asked.push(reply)
    if (yes instanceof Error) throw yes
    return yes
  }
  return { asked, unsure }
}

describe("the claims gate", () => {
  it("runs a done state again only when this turn's results hold evidence for none", async () => {
    const reply = "Your reminder is set for 8am tomorrow."
    const { asked, unsure } = jev(true)
    expect(await claimsGate(unsure)(reply, shown("Hi"))).toBe(
      `${CLAIMS_NOTE} "is set".`
    )
    expect(await claimsGate(unsure)(reply, shown("Hi", { value: SET }))).toBe(
      null
    )
    // Evidence from an earlier turn backs nothing reply now.
    expect(
      await claimsGate(unsure)(reply, shown("Hi", { before: true, value: SET }))
    ).not.toBeNull()
    // A condition, a future, a no and a question claim nothing.
    for (const text of [
      "I'll tell you once it's live.",
      "It isn't live yet.",
      "It will be connected within the hour.",
      "Is the reminder set?",
    ]) {
      expect(await claimsGate(unsure)(text, shown("Hi"))).toBe(null)
    }
    expect(asked).toEqual([])
  })

  it("takes only a page that answered 2xx as a site being live", async () => {
    const reply = "Your website is now live."
    const record = { evidence: [{ kind: "record", table: "domains" }] }
    const page = (status: number) => ({
      evidence: [
        { kind: "url", url: "https://x.example", status, checked_at: "" },
      ],
    })
    const { unsure } = jev(false)
    expect(
      await claimsGate(unsure)(reply, shown("Hi", { value: record }))
    ).not.toBeNull()
    expect(
      await claimsGate(unsure)(reply, shown("Hi", { value: page(404) }))
    ).not.toBeNull()
    expect(
      await claimsGate(unsure)(reply, shown("Hi", { value: page(200) }))
    ).toBe(null)
  })

  it("takes the workspace the turn read as backing for what already stands", async () => {
    const reply = "Your website is live."
    const { asked, unsure } = jev(true)
    // An org with no published site: the unchecked live claim is caught.
    expect(
      await claimsGate(unsure)(reply, shown(withWorkspace(UNPUBLISHED)))
    ).toBe(`${CLAIMS_NOTE} "is live".`)
    expect(
      await claimsGate(unsure)(reply, shown(withWorkspace(PUBLISHED)))
    ).toBe(null)
    // A connected domain, or a get_workspace since the owner's message, backs it too.
    const domain = {
      ...UNPUBLISHED,
      domains: [{ name: "tidy.co.uk", state: "connected" }],
    }
    expect(
      await claimsGate(unsure)(
        "tidy.co.uk is connected.",
        shown(withWorkspace(domain))
      )
    ).toBe(null)
    expect(
      await claimsGate(unsure)(
        reply,
        shown(withWorkspace(UNPUBLISHED), {
          tool: "get_workspace",
          value: PUBLISHED,
        })
      )
    ).toBe(null)
    // A reminder the workspace lists is set.
    const reminder = {
      ...UNPUBLISHED,
      reminders: [{ ref: "r1", title: "Call the supplier", due: "8:00 AM" }],
    }
    expect(
      await claimsGate(unsure)(
        "Your reminder to call the supplier is set for 8am.",
        shown(withWorkspace(reminder))
      )
    ).toBe(null)
    expect(asked).toEqual([])
  })

  it("runs a pending state again unless the workspace shows it", async () => {
    const { asked, unsure } = jev(true)
    const site = (live: boolean) => ({ address: "tidy.reme.site", live })
    const none = { site: site(true), builds: [], questions: [] }
    const table: [string, object, boolean][] = [
      [
        "It's waiting for your approval.",
        { ...none, reviews_waiting: 0 },
        true,
      ],
      [
        "It's waiting for your approval.",
        { ...none, reviews_waiting: 1 },
        false,
      ],
      [
        "Your change is ready to publish.",
        {
          ...none,
          reviews_waiting: 0,
          builds: [{ state: "ready for the owner to look over" }],
        },
        false,
      ],
      ["Tap Publish when you're ready.", { ...none, reviews_waiting: 0 }, true],
      ["Your website is not live yet.", none, true],
      ["Your website is not live yet.", { ...none, site: site(false) }, false],
      ["Tidy Co needs your answer.", none, true],
      [
        "Tidy Co needs your answer.",
        { ...none, questions: [{ about: "phone number" }] },
        false,
      ],
      // A condition, a future, a question or no workspace claims nothing.
      ["Once you approve it, it goes live.", none, false],
      ["Is it waiting for your approval?", none, false],
      ["Once it's ready to publish, tap Publish.", none, false],
    ]
    for (const [reply, workspace, reran] of table) {
      const note = await claimsGate(unsure)(
        reply,
        shown(withWorkspace(workspace))
      )
      expect(note !== null, `${reply} ${JSON.stringify(workspace)}`).toBe(reran)
    }
    expect(
      await claimsGate(unsure)("It's waiting for your approval.", shown("Hi"))
    ).toBe(null)
    expect(asked).toEqual([])
  })

  it("reads the workspace block the agent's context writes, labels and all", async () => {
    const context = (live: boolean, domain: "active" | "verifying") =>
      contextOf("ask", {
        site: { host: "tidy.reme.site", live_version: live ? 3 : null },
        builds: [],
        questions: [],
        approvals: [],
        missing_facts: [],
        domains: [{ name: "tidy.co.uk", state: domain, last_check: null }],
        expected_seconds: {
          quick: { p50: 15, p95: 45 },
          full: { p50: 180, p95: 330 },
        },
        expected_range: { quick: "about a minute", full: "a few minutes" },
      }).text
    const { unsure } = jev(false)
    const gate = (reply: string, text: string) =>
      claimsGate(unsure)(reply, shown(text))
    expect(
      await gate("Your website is live.", context(true, "verifying"))
    ).toBe(null)
    expect(
      await gate("Your website is live.", context(false, "verifying"))
    ).not.toBeNull()
    expect(
      await gate("tidy.co.uk is connected.", context(false, "active"))
    ).toBe(null)
    expect(
      await gate("tidy.co.uk is connected.", context(false, "verifying"))
    ).not.toBeNull()
  })

  it("reads a value that is set to something as a fact, not a done state", async () => {
    const hours = withWorkspace(
      UNPUBLISHED,
      'Facts: hours.weekday: {"open":"09:00","close":"17:00"}'
    )
    for (const reply of [
      "Your hours are set to 9 to 5.",
      "Your hours are all set to 9 to 5 on weekdays.",
    ]) {
      const { asked, unsure } = jev(false)
      expect(await claimsGate(unsure)(reply, shown(hours))).toBe(null)
      // Hours are the decision model's to match, never a done state.
      expect(asked).toEqual([reply])
    }
  })

  it("passes the owner's stored price without asking Jev", async () => {
    const { asked, unsure } = jev(true)
    expect(
      await claimsGate(unsure)(
        "A regular clean is £60 and a deep clean £180.",
        shown(PRICES)
      )
    ).toBe(null)
    expect(asked).toEqual([])
  })

  it("runs an invented price again: at once when no price was shown, through Jev when some were", async () => {
    const reply = "An oven clean is £45."
    const none = jev(false)
    expect(await claimsGate(none.unsure)(reply, shown("Hi"))).toBe(
      `${CLAIMS_NOTE} "£45".`
    )
    // The instructions' £99 is no fact either.
    expect(
      await claimsGate(none.unsure)("A clean is £99.", shown("Hi"))
    ).not.toBeNull()
    expect(none.asked).toEqual([])
    // With the owner's prices shown, £45 could be worked out from them.
    const yes = jev(true)
    expect(await claimsGate(yes.unsure)(reply, shown(PRICES))).toBe(
      `${CLAIMS_NOTE} "£45".`
    )
    expect(yes.asked).toEqual([reply])
    const no = jev(false)
    expect(
      await claimsGate(no.unsure)("Both together come to £240.", shown(PRICES))
    ).toBe(null)
    expect(no.asked).toHaveLength(1)
  })

  it("asks Jev about a claim word or an area, and passes the reply when Jev fails", async () => {
    for (const reply of [
      "We're fully insured for every job.",
      "We cover all of Leeds and Bradford.",
    ]) {
      const down = jev(new Error("jev is down"))
      expect(await claimsGate(down.unsure)(reply, shown(PRICES))).toBe(null)
      expect(down.asked).toEqual([reply])
    }
    // A claim word the turn was shown passes without Jev.
    const { asked, unsure } = jev(true)
    expect(
      await claimsGate(unsure)(
        "Yes, you're fully insured.",
        shown("Facts: about.insurance: Fully insured with Hiscox")
      )
    ).toBe(null)
    expect(asked).toEqual([])
  })

  it("runs the model again at most once a turn, inside the promise gate's cap", async () => {
    // A claim that never goes away gets one re-run, though two are left.
    const once = scripted(said("You're all set."))
    await run(once.model, async () => false, [claimsGate(jev(false).unsure)])
      .done
    expect(once.prompts).toHaveLength(2)
    const rerun = once.prompts[1] as { content: { text: string }[] }[]
    expect(rerun.at(-1)?.content[0]?.text).toBe(`${CLAIMS_NOTE} "all set".`)
    // A promise re-run first spends the budget the claim shares.
    let promises = 0
    const shared = scripted(said("You're all set."))
    await run(shared.model, async () => promises++ < 2, [
      claimsGate(jev(false).unsure),
    ]).done
    expect(shared.prompts).toHaveLength(1 + MAX_RERUNS)
    const last = shared.prompts.at(-1) as { content: { text: string }[] }[]
    expect(last.at(-1)?.content[0]?.text).toBe(NUDGE)
  })
})
