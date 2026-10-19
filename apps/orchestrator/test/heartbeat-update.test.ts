import type { Tenancy } from "@workspace/db"
import { describe, expect, it, vi } from "vitest"
import {
  faithful,
  type Spent,
  type Update,
  type writeText,
  writeUpdate,
} from "../src/heartbeat-write.ts"

const SPENT: Spent = {
  model: "stand-in",
  cost_usd: 0.002,
  usage: { input_tokens: 300, output_tokens: 40 },
  ms: 5,
}
const UPDATE: Update = {
  facts: { host: "www.brightclean.co.uk", days: "3" },
  template:
    "I didn't see the records for www.brightclean.co.uk within 3 days, so I've stopped watching.",
}

/** A kit whose spend row is counted, not written. */
function kitFor() {
  const logged = vi.fn()
  const kit = {
    withOrg: async (_ctx: unknown, fn: (db: unknown) => unknown) =>
      fn({ insert: () => ({ values: logged }) }),
  } as unknown as Tenancy
  return { kit, logged }
}

const writer = (text: string | Error) =>
  vi.fn<typeof writeText>(async () => {
    if (text instanceof Error) throw text
    return { text, spent: SPENT }
  })

const env = { OPENROUTER_API_KEY: "test-key" }

describe("a model-written update", () => {
  it("keeps the model's words when every value is quoted and nothing is added", async () => {
    const { kit, logged } = kitFor()
    const text =
      "I've stopped watching www.brightclean.co.uk: its records didn't show up within 3 days. Say the word and I'll try again."
    expect(await writeUpdate(env, kit, "org", UPDATE, writer(text))).toBe(text)
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "cos.background_step",
        payload: expect.objectContaining({
          job: "update",
          outcome: "written",
          cost_usd: 0.002,
        }),
      })
    )
  })

  it("falls back to the template on a fabricated number", async () => {
    const { kit, logged } = kitFor()
    const text =
      "I've stopped watching www.brightclean.co.uk after 72 hours without its records."
    expect(await writeUpdate(env, kit, "org", UPDATE, writer(text))).toBe(
      UPDATE.template
    )
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ outcome: "template" }),
      })
    )
  })

  it("falls back on a model error, a missing value, a quiet reply or no key", async () => {
    const { kit } = kitFor()
    for (const reply of [
      new Error("upstream 502"),
      "I've stopped watching your domain after 3 days.",
      "[quiet] nothing to say",
      "",
    ])
      expect(await writeUpdate(env, kit, "org", UPDATE, writer(reply))).toBe(
        UPDATE.template
      )
    const never = writer("unused")
    expect(await writeUpdate({}, kit, "org", UPDATE, never)).toBe(
      UPDATE.template
    )
    expect(never).not.toHaveBeenCalled()
  })

  it("asks for the facts and the draft, with a short timeout", async () => {
    const { kit } = kitFor()
    const write = writer(UPDATE.template)
    await writeUpdate(env, kit, "org", UPDATE, write)
    expect(write).toHaveBeenCalledWith(
      "test-key",
      expect.stringMatching(/Quote every value in the facts exactly/),
      { facts: UPDATE.facts, draft: UPDATE.template },
      15_000
    )
  })
})

describe("faithful", () => {
  it("wants every value verbatim and no other number or link", () => {
    const facts = { host: "sparkle.co.uk", slug: "sparkle-stg.remeai.co.uk" }
    expect(
      faithful(
        "sparkle.co.uk is live, and sparkle-stg.remeai.co.uk forwards to it.",
        facts
      )
    ).toBe(true)
    expect(faithful("sparkle.co.uk is live.", facts)).toBe(false)
    expect(
      faithful(
        "sparkle.co.uk is live, and sparkle-stg.remeai.co.uk forwards to it in 2 minutes.",
        facts
      )
    ).toBe(false)
    expect(
      faithful(
        "sparkle.co.uk is live; sparkle-stg.remeai.co.uk forwards to it. See cheap.biz too.",
        facts
      )
    ).toBe(false)
  })
})
