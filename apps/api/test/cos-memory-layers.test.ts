import {
  CosPrefix,
  type MemoryOperation,
  NOTES_MAX_CHARS,
  type ProfileLine,
  SKILL_NOTES_KEY,
} from "@workspace/contracts"
import {
  appendSessionEvent,
  conversations,
  supersedeFact,
  type Tenancy,
  tenancy,
} from "@workspace/db"
import { procedure } from "@workspace/skills"
import type { ModelMessage } from "ai"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { recentSkills } from "../src/chat.ts"
import {
  BUDGET_WARNING_RATIO,
  budgetLine,
  LAYER_CAPS,
  LIMITS,
  lastStep,
  layersOf,
  WARN_AT,
} from "../src/cos/agent.ts"
import {
  applyOperations,
  CONSOLIDATE_AT,
  editLine,
  layerOf,
  memory,
  memoryView,
  readLayer,
  refusalOf,
  STORES,
  sameFact,
  skillNotesText,
  undoVersion,
} from "../src/cos/memory.ts"
import { recall } from "../src/cos/recall.ts"
import { viewOf } from "../src/cos/skills.ts"
import type { ToolContext } from "../src/cos/tools.ts"
import { type Owner, owner } from "./owner-fixture.ts"

/**
 * The memory rules code enforces (round 3, after Hermes): the three
 * targets, the checks every line passes, consolidation, conversation
 * search, the skill notes and their page, and the step budget.
 */

const AT = "2026-11-05T10:00:00.000Z"
let n = 0
const line = (text: string, source: ProfileLine["source"] = "owner_said") => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  text,
  source,
  at: AT,
})
const add = (content: string): MemoryOperation => ({ action: "add", content })

describe("what no store accepts", () => {
  it.each([
    ["The lockbox code is 4821", "secret"],
    ["4821 is the alarm code", "secret"],
    ["Wi-Fi password is fluffybunny", "secret"],
    ["Card 4242 4242 4242 4242 for supplies", "secret"],
    ["Sort code 12-34-56 for refunds", "secret"],
    ["Keys are in the lockbox by the back door", null],
    ["Phone them on 07700 900 123", null],
    ["Always reply briefly", "order"],
    ["Prefers short replies", null],
  ])("%s: %s", (text, why) => {
    expect(refusalOf(text)).toBe(why)
  })

  it("refuses a secret, a business fact, a near-duplicate and a fact another layer holds, each saying why", () => {
    const held = [line("Prefers calls after 4pm")]
    const code = (ops: MemoryOperation[], elsewhere = []) => {
      const done = applyOperations(
        held,
        ops,
        "owner_said",
        AT,
        null,
        undefined,
        1_500,
        elsewhere
      )
      return "refusal" in done ? done.refusal.code : "ok"
    }
    expect(code([add("Door code 4821")])).toBe("memory.secret")
    expect(code([add("Charges £25 an hour")])).toBe("memory.business_fact")
    expect(code([add("Prefers calls after 4 pm")])).toBe("memory.duplicate")
    expect(
      sameFact("Prefers calls after 4pm", "prefers CALLS after 4pm.")
    ).toBe(true)
    expect(sameFact("Prefers calls after 4pm", "Walks dogs on Mondays")).toBe(
      false
    )
    const elsewhere = [
      { where: "the working notes", text: "Keys are kept in the van" },
    ]
    const done = applyOperations(
      held,
      [add("Keys are kept in the van")],
      "owner_said",
      AT,
      null,
      undefined,
      1_500,
      elsewhere
    )
    expect(done).toMatchObject({
      refusal: {
        code: "memory.elsewhere",
        message: expect.stringContaining("the working notes already holds"),
      },
    })
  })

  it("patches a span, refuses one that occurs twice, and checks only the words the patch adds", () => {
    const held = [line("Calls after 4pm, texts after 4pm")]
    expect(
      applyOperations(
        held,
        [{ action: "patch", old_text: "4pm", content: "5pm" }],
        "owner_said",
        AT
      )
    ).toMatchObject({ refusal: { code: "memory.ambiguous_match" } })
    const one = [line("Prefers calls after 4pm")]
    const done = applyOperations(
      one,
      [{ action: "patch", old_text: "4pm", content: "5pm" }],
      "owner_said",
      AT,
      ["Make it 5pm now."]
    )
    expect(done.ok && done.lines[0]?.text).toBe("Prefers calls after 5pm")
  })
})

describe("consolidation", () => {
  const long = (c: string) => c.repeat(300)
  const four = () => ["a", "b", "c", "d"].map((c) => line(long(c)))

  it("refuses an add alone past four fifths, and takes one that merges or removes in the same batch", () => {
    const held = four()
    const used = held.map((l) => l.text).join("\n").length
    expect(used / 1_500).toBeGreaterThanOrEqual(CONSOLIDATE_AT)
    const alone = applyOperations(
      held,
      [add("Walks dogs on Mondays")],
      "owner_said",
      AT
    )
    expect(alone).toMatchObject({
      full: {
        note: expect.stringContaining("Consolidate rather than pile up"),
      },
    })
    expect(
      applyOperations(
        held,
        [{ action: "remove", old_text: "aaa" }, add("Walks dogs on Mondays")],
        "owner_said",
        AT
      )
    ).toMatchObject({ ok: true })
  })

  it("never truncates: a batch past the budget changes nothing and names what to free", () => {
    const held = four().slice(0, 3)
    const over = applyOperations(
      held,
      [add(long("e")), add(long("f"))],
      "owner_said",
      AT
    )
    expect(over).toMatchObject({
      full: {
        lines: held,
        note: expect.stringMatching(/free at least [\d,]+ chars/),
      },
    })
  })
})

describe("the step budget", () => {
  it("warns once three quarters are used, and keeps the last step for words", () => {
    expect(BUDGET_WARNING_RATIO).toBe(0.75)
    expect(LIMITS.steps).toBe(16)
    expect(WARN_AT).toBe(12)
    expect(budgetLine(12)).toBe(
      "Notice from the app, not the owner: you have used 12 of 16 steps this turn, so 4 are left. Finish the work in hand and end with a reply that says what is done and what is left."
    )
    const run = { price: { input: 1, output: 1, cacheRead: 0 }, reserved: 1 }
    expect(lastStep(15, [], run)).toBe("steps")
    expect(lastStep(3, [], run)).toBeNull()
    const step = {
      usage: {
        inputTokens: 200_000,
        outputTokens: 0,
        totalTokens: 200_000,
        inputTokenDetails: {
          noCacheTokens: 200_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
      },
      response: { messages: [] },
    }
    // A step of 200k tokens at $1 a million leaves no room for two more under $0.5.
    expect(lastStep(1, [step], { ...run, reserved: 0.5 })).toBe("budget")
  })

  it("has each layer's cap within the input a step is reserved for", () => {
    const sum = Object.values(LAYER_CAPS).reduce((a, b) => a + b, 0)
    expect(sum).toBeLessThanOrEqual(LIMITS.inputTokens)
  })

  it("measures a call by layer: history, skill views, memory, notes, the message and the turn's steps", () => {
    const prefix = CosPrefix.parse({
      version: "61",
      instructions: "x".repeat(400),
      tools: [],
      sha256: "a".repeat(64),
    })
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "y".repeat(400) }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c",
            toolName: "skill_view",
            output: { type: "json", value: { body: "z".repeat(800) } },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Mode: ask.\n<data source="owner_profile" taint="untrusted_input">\n${"p".repeat(400)}\n</data>\nOpen items`,
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "w".repeat(80) }] },
    ]
    const got = layersOf(messages, prefix)
    expect(got.core).toBe(100)
    expect(got.skill_views).toBeGreaterThan(200)
    expect(got.history).toBeGreaterThan(100)
    expect(got.memory).toBeGreaterThan(100)
    expect(got.message).toBeGreaterThan(0)
    expect(got.steps).toBeGreaterThan(20)
  })
})

describe("a skill's notes", () => {
  it("come with the core only, headed and full of the owner's lines", () => {
    const skill = procedure("cos", "quote-reply")
    if (!skill) throw new Error("no quote-reply")
    const notes =
      "Notes for this business: [5%, 28/600 chars]\nQuotes include parking costs"
    expect(viewOf(skill, undefined, "Drafting", notes)).toMatchObject({ notes })
    const part = procedure("cos", "web-address")?.parts[0]?.name
    expect(
      viewOf(procedure("cos", "web-address") as never, part, "Drafting", notes)
    ).not.toHaveProperty("notes")
    expect(layerOf("skill:no-such-skill")).toBeNull()
  })
})

const url = process.env.DATABASE_URL

describe.skipIf(!url)("on a live connection", () => {
  const kit: Tenancy = tenancy(url as string, { max: 2 })
  let me: Owner
  let them: Owner

  beforeAll(async () => {
    me = await owner(kit, url as string, "cos-layers")
    them = await owner(kit, url as string, "cos-layers-other")
  }, 60_000)

  afterAll(() => kit.close())

  const ctx = (who: Owner) =>
    ({ kit, owner: { orgId: who.orgId } }) as unknown as ToolContext

  /** A conversation of `who` holding `said` as the owner's messages, and an assistant reply. */
  async function session(who: Owner, said: string[], reply = "Noted.") {
    return kit.withOrg({ orgId: who.orgId }, async (db) => {
      const [made] = await db
        .insert(conversations)
        .values({
          orgId: who.orgId,
          kind: "assistant",
          createdByStaffId: who.chiefId,
        })
        .returning({ id: conversations.id })
      const id = made?.id as string
      const put = (type: string, payload: Record<string, unknown>) =>
        appendSessionEvent(db, {
          orgId: who.orgId,
          staffId: who.chiefId,
          assignmentId: null,
          sessionId: id,
          type,
          payload,
        })
      for (const [i, text] of said.entries()) {
        await put("cos.message", {
          turn_id: "01J00000000000000000000000",
          message: {
            id: `u${i}`,
            role: "user",
            parts: [{ type: "text", text }],
          },
        })
      }
      await put("cos.message", {
        turn_id: "01J00000000000000000000000",
        message: {
          id: "a0",
          role: "assistant",
          parts: [{ type: "text", text: reply }],
        },
      })
      // Later rows go in a transaction of their own.
      const later = (type: string, payload: Record<string, unknown>) =>
        kit.withOrg({ orgId: who.orgId }, (next) =>
          appendSessionEvent(next, {
            orgId: who.orgId,
            staffId: who.chiefId,
            assignmentId: null,
            sessionId: id,
            type,
            payload,
          })
        )
      return { id, put: later }
    })
  }
  const turnIn = (sessionId: string) => ({
    orgId: me.orgId,
    staffId: me.chiefId,
    sessionId,
    turnId: "01J00000000000000000000009",
  })

  it("writes a skill's notes for this business, apart from the profile, and returns them with the skill", async () => {
    const { id } = await session(me, [
      "For city centre quotes, add the parking costs.",
    ])
    const out = await memory(
      ctx(me),
      {
        target: "skill:quote-reply",
        operations: [add("City centre quotes add the parking costs")],
      },
      "",
      turnIn(id)
    )
    expect(out).toMatchObject({
      outcome: "saved",
      target: "skill:quote-reply",
      fullness: "7%, 40/600 chars",
    })
    expect(
      await memory(
        ctx(me),
        { target: "skill:no-such", operations: [add("x")] },
        "",
        turnIn(id)
      )
    ).toMatchObject({ outcome: "refused", error: { code: "memory.no_skill" } })
    const text = await kit.withOrg({ orgId: me.orgId }, (db) =>
      skillNotesText(db, "quote-reply")
    )
    expect(text).toBe(
      "Notes for this business: [7%, 40/600 chars]\nCity centre quotes add the parking costs"
    )
    // The other business has none: the skill is shared, its notes are not.
    expect(
      await kit.withOrg({ orgId: them.orgId }, (db) =>
        skillNotesText(db, "quote-reply")
      )
    ).toBeUndefined()
    expect(
      (
        await kit.withOrg({ orgId: me.orgId }, (db) =>
          readLayer(db, layerOf("user") as never)
        )
      ).lines
    ).toEqual([])
  })

  it("refuses a line one of the business facts already holds, naming where it lives", async () => {
    await kit.withOrg({ orgId: me.orgId }, (db) =>
      supersedeFact(db, {
        orgId: me.orgId,
        key: "business.service_area",
        factType: "business",
        value: { areas: ["Bristol city centre", "Clifton village"] },
        provenance: { source: "owner_stated", confidence: 1 },
      })
    )
    const { id } = await session(me, [
      "We cover Bristol city centre and Clifton village.",
    ])
    expect(
      await memory(
        ctx(me),
        { target: "notes", operations: [add("Bristol city centre")] },
        "",
        turnIn(id)
      )
    ).toMatchObject({
      outcome: "refused",
      error: {
        code: "memory.elsewhere",
        message: expect.stringContaining("business.service_area"),
      },
    })
  })

  it("lets the owner edit, remove and undo a note, and shows every store on the page with stale skill notes marked", async () => {
    const { id } = await session(me, [
      "The spare keys are kept in the van glovebox.",
    ])
    await memory(
      ctx(me),
      {
        target: "notes",
        operations: [add("Spare keys are kept in the van glovebox")],
      },
      "",
      turnIn(id)
    )
    const view = await kit.withOrg({ orgId: me.orgId }, (db) => memoryView(db))
    expect(view.notes).toMatchObject({
      max: NOTES_MAX_CHARS,
      lines: [{ text: "Spare keys are kept in the van glovebox" }],
    })
    expect(view.skills.notes).toMatchObject([
      { name: "quote-reply", title: "Quote reply", lines: [{ stale: false }] },
    ])
    const target = view.notes.lines[0]?.id as string
    expect(
      await kit.withOrg({ orgId: me.orgId }, (db) =>
        editLine(db, me.orgId, {
          store: "notes",
          id: target,
          text: "The lockbox code is 4821",
        })
      )
    ).toMatchObject({ code: "memory.secret" })
    const edited = await kit.withOrg({ orgId: me.orgId }, (db) =>
      editLine(db, me.orgId, {
        store: "notes",
        id: target,
        text: "Spare keys are in the office drawer",
      })
    )
    expect(edited).toHaveProperty("version")
    const after = await kit.withOrg({ orgId: me.orgId }, (db) => memoryView(db))
    expect(after.notes.lines).toMatchObject([
      { text: "Spare keys are in the office drawer", source: "owner_said" },
    ])
    const undone = await kit.withOrg({ orgId: me.orgId }, (db) =>
      undoVersion(db, me.orgId, after.notes.version, STORES.notes)
    )
    expect(undone).toEqual({ version: after.notes.version + 1 })
    expect(
      (await kit.withOrg({ orgId: me.orgId }, (db) => memoryView(db))).notes
        .lines
    ).toMatchObject([{ text: "Spare keys are kept in the van glovebox" }])
    expect(
      await kit.withOrg({ orgId: me.orgId }, (db) =>
        editLine(db, me.orgId, { store: "notes", id: target })
      )
    ).toHaveProperty("version")
    // A note older than sixty days whose skill has not loaded since is shown as stale, never removed.
    await kit.withOrg({ orgId: me.orgId }, async (db) => {
      const { all } = await readLayer(db, layerOf("skill:quote-reply") as never)
      const { supersedePrivateFact } = await import("@workspace/db")
      await supersedePrivateFact(db, {
        orgId: me.orgId,
        key: SKILL_NOTES_KEY,
        factType: "owner",
        value: {
          lines: all.map((l) => ({ ...l, at: "2026-08-01T10:00:00.000Z" })),
        },
        provenance: { source: "owner_stated", confidence: 1 },
      })
    })
    const stale = await kit.withOrg({ orgId: me.orgId }, (db) => memoryView(db))
    expect(stale.skills.notes[0]?.lines).toMatchObject([{ stale: true }])
  })

  it("searches only this org's earlier conversations, best and newest first, never tool results", async () => {
    await session(me, ["The van is parked behind the bakery on Tuesdays."])
    const { put } = await session(me, ["Our van broke down last week."])
    await put("cos.tool_result", {
      turn_id: "01J00000000000000000000000",
      tool_call_id: "c1",
      tool: "get_facts",
      output: { note: "the van parked secretly" },
    })
    await session(them, ["Their van is parked at the depot."])
    const current = await session(me, ["Where is the van parked?"])
    const found = await kit.withOrg({ orgId: me.orgId }, (db) =>
      recall(db, "van parked", current.id)
    )
    expect(found.outcome).toBe("found")
    const snippets =
      found.outcome === "found" ? found.results.map((r) => r.snippet) : []
    expect(snippets[0]).toContain("bakery")
    expect(snippets.join(" ")).not.toContain("depot")
    expect(snippets.join(" ")).not.toContain("secretly")
    expect(snippets.join(" ")).not.toContain("Where is the van")
    expect(
      await kit.withOrg({ orgId: them.orgId }, (db) =>
        recall(db, "bakery", null)
      )
    ).toEqual({ outcome: "none" })
  })

  it("counts the model's own skill views as loaded, so a trigger after one loads it again only after a compaction", async () => {
    const { id, put } = await session(me, ["Help with my web address"])
    expect(
      await kit.withOrg({ orgId: me.orgId }, (db) => recentSkills(db, id))
    ).toEqual([])
    await put("cos.tool_result", {
      turn_id: "01J00000000000000000000000",
      tool_call_id: "c2",
      tool: "skill_view",
      output: {
        outcome: "skill",
        name: "web-address",
        body: "# Web address",
        status: "Drawing on my domain expertise",
      },
    })
    await put("cos.skill", {
      name: "google-search",
      body: "# Google search",
      status: "x",
      trigger: "connect_google",
    })
    expect(
      (
        await kit.withOrg({ orgId: me.orgId }, (db) => recentSkills(db, id))
      ).sort()
    ).toEqual(["google-search/", "web-address/"])
  })
})
