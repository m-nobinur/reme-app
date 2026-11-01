import { COS_TOOLS, type CosToolName, CosWorkspace } from "@workspace/contracts"
import { generateText, isStepCount, tool } from "ai"
import { describe, expect, it } from "vitest"
import {
  contextOf,
  DEFAULT_MODEL,
  DESCRIPTIONS,
  INSTRUCTIONS,
  openrouterModel,
} from "../src/cos/agent.ts"
import { workspaceLabels } from "../src/cos/labels.ts"

/**
 * Live: when the Chief of Staff gives a tip and when it must not, with the
 * real model, the real instructions and the real context text. Tools are
 * stubs that record what was called. It spends money, so it runs only with
 * `TIPS_LIVE=1` and `OPENROUTER_API_KEY`.
 */

const KEY = process.env.OPENROUTER_API_KEY ?? ""
const LIVE = process.env.TIPS_LIVE === "1" && KEY !== ""

const facts = (email: string, phone: string) => [
  { key: "business.name", value: { name: "DOX Cleaning" } },
  { key: "business.industry", value: { id: "cleaning", name: "Cleaning" } },
  {
    key: "service_area.text",
    value: { text: "Leeds and the surrounding area" },
  },
  { key: "business.email", value: { address: email } },
  { key: "business.phone", value: { e164: phone } },
]

const workspace = (tips: ("business_email" | "local_phone")[]) =>
  CosWorkspace.parse({
    site: { host: "dox-cleaning.remeai.co.uk", live_version: 1 },
    builds: [],
    questions: [],
    approvals: [],
    missing_facts: [],
    domains: [{ name: "doxcleaning.co.uk", state: "active", last_check: null }],
    tips,
    expected_seconds: {
      quick: { p50: 45, p95: 90 },
      full: { p50: 360, p95: 600 },
    },
  })

async function turn(tips: ("business_email" | "local_phone")[], said: string) {
  const model = openrouterModel(KEY, DEFAULT_MODEL)
  if (!model) throw new Error(`no route for ${DEFAULT_MODEL}`)
  const ws = workspace(tips)
  const called: { name: string; input: unknown }[] = []
  const stub = (name: CosToolName, output: unknown) =>
    tool({
      description: DESCRIPTIONS[name],
      inputSchema: COS_TOOLS[name].input,
      execute: async (input: unknown) => {
        called.push({ name, input })
        return output
      },
    })
  const result = await generateText({
    model,
    system: INSTRUCTIONS,
    tools: {
      get_workspace: stub("get_workspace", workspaceLabels(ws)),
      put_off: stub("put_off", {
        outcome: "put_off",
        until: "9999-12-31T00:00:00.000Z",
      }),
      create_reminder: stub("create_reminder", {
        outcome: "created",
        title: "Call Sam",
      }),
    },
    stopWhen: isStepCount(4),
    messages: [
      {
        role: "user",
        content: contextOf(
          "act",
          ws,
          "Europe/London",
          new Date("2026-11-02T10:00:00Z"),
          undefined,
          undefined,
          false,
          null,
          facts("jo@gmail.com", "+442079460000") as never
        ).text,
      },
      { role: "user", content: said },
    ],
  })
  return {
    reply: result.steps
      .map((s) => s.text)
      .join(" ")
      .trim(),
    tipsGiven: called
      .filter((c) => c.name === "put_off")
      .map((c) => (c.input as { kind: string }).kind),
  }
}

describe.skipIf(!LIVE)("tips with the real model", () => {
  it("gives a business-email tip when the owner asks about the website, then records it", async () => {
    const { reply, tipsGiven } = await turn(
      ["business_email"],
      "Is my website all sorted now?"
    )
    console.log("      fires, email:", reply)
    expect(tipsGiven).toEqual(["business_email"])
    expect(reply).toMatch(/email/i)
  }, 120_000)

  it("gives a local-number tip when the owner asks about the website, then records it", async () => {
    const { reply, tipsGiven } = await turn(
      ["local_phone"],
      "Can you tell me where things stand with the website?"
    )
    console.log("      fires, phone:", reply)
    expect(tipsGiven).toEqual(["local_phone"])
    expect(reply).toMatch(/number|phone/i)
  }, 120_000)

  it("gives no tip when the workspace lists none, even with a free-mail address in the facts", async () => {
    const { reply, tipsGiven } = await turn([], "Is my website all sorted now?")
    console.log("      quiet, none listed:", reply)
    expect(tipsGiven).toEqual([])
    expect(reply).not.toMatch(/gmail|own email|business email|local number/i)
  }, 120_000)

  it("gives no tip on something unrelated to the website", async () => {
    const { reply, tipsGiven } = await turn(
      ["business_email", "local_phone"],
      "Remind me to call Sam tomorrow at 9am."
    )
    console.log("      quiet, unrelated:", reply)
    expect(tipsGiven).toEqual([])
    expect(reply).not.toMatch(/gmail|business email|local number/i)
  }, 120_000)
})
