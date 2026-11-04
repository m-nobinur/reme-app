import {
  ADDRESS_ASK,
  addressQuestions,
  type CosWorkspace,
  type OwnerTask,
} from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import { contextOf } from "../src/cos/agent.ts"
import { CONTEXT_POLICY, deriveCosMessages } from "../src/cos/history.ts"
import {
  cardState,
  handoverNote,
  openItems,
  sessionNote,
  skillsDue,
} from "../src/cos/notes.ts"

const NOW = new Date("2026-11-05T10:00:00.000Z")
const EMPTY: CosWorkspace = {
  site: { host: null, live_version: null },
  builds: [],
  questions: [],
  approvals: [],
  missing_facts: [],
}

const step = (name: string, state: string, note: string | null = null) => ({
  step: name,
  state,
  note,
  blocked_on: state === "blocked" ? "owner_action" : null,
  deadline: null,
  changed_at: null,
})
const address = (over: Record<string, unknown>): OwnerTask =>
  ({
    id: crypto.randomUUID(),
    kind: "address",
    state: "active",
    later_until: null,
    created_at: NOW.toISOString(),
    done_at: null,
    detail: {},
    steps: [],
    ...over,
  }) as OwnerTask

const answered = (choice: string | null, here = true) => {
  const stack = addressQuestions()
  const [have, name] = stack.questions
  if (choice && have) have.answer = { kind: "value", value: choice }
  if (choice && choice !== ADDRESS_ASK.yes && name)
    name.answer = { kind: "closed" }
  return cardState(stack, here)
}

describe("the address card's state", () => {
  it("reads the pick by place and what still waits on screen", () => {
    expect(answered(null)).toEqual({ answer: null, waiting: "have" })
    expect(answered(ADDRESS_ASK.yes)).toEqual({
      answer: "yes",
      waiting: "name",
    })
    expect(answered(ADDRESS_ASK.later)).toEqual({
      answer: "later",
      waiting: null,
    })
    // A card in another conversation is not on this screen.
    expect(answered(null, false)).toEqual({ answer: null, waiting: null })
  })
})

describe("the open items note", () => {
  it("says a skipped address is unknown and must be asked, with no card on screen", () => {
    const later = address({
      state: "later",
      later_until: "2026-11-12T10:00:00.000Z",
    })
    const lines = openItems(
      { ...EMPTY, tasks: [later] },
      answered(ADDRESS_ASK.later),
      NOW,
      "Europe/London"
    )
    expect(lines[0]).toMatch(/never guess/)
    expect(lines).toContain(
      "- Web address: not settled. The owner chose Skip for now on the address card, until Thursday 12 November. Whether they have a domain is unknown: ask, never guess."
    )
    expect(lines).toContain(
      "- Google: not connected; it waits for a domain of the website's own."
    )
    expect(lines.at(-1)).toMatch(/No question card waits on screen/)
  })

  it("asks for the name when the owner said yes but gave none", () => {
    const lines = openItems(EMPTY, { answer: "yes", waiting: null }, NOW)
    expect(lines.join("\n")).toMatch(/its name is unknown: ask for it/)
  })

  it("points at the card only while it waits for the name", () => {
    const lines = openItems(EMPTY, answered(ADDRESS_ASK.yes), NOW)
    expect(lines.at(-1)).toMatch(/asks for the domain's name/)
  })

  it("picks the thread back up when the owner is buying a domain themselves", () => {
    const buying = address({
      detail: { name: "sparkleclean.co.uk", origin: "buying_elsewhere" },
      steps: [
        step("find_out", "done"),
        step("choose", "done"),
        step("purchase", "blocked", "buying sparkleclean.co.uk"),
      ],
    })
    const text = openItems(
      { ...EMPTY, tasks: [buying], approvals: [] },
      null,
      NOW
    ).join("\n")
    expect(text).toMatch(
      /buying sparkleclean\.co\.uk themselves\. When they say it's bought, call domain_bought/
    )
    const shown = address({
      detail: { name: "sparkleclean.co.uk", origin: "buying_elsewhere" },
      steps: [step("purchase", "done")],
    })
    expect(
      openItems({ ...EMPTY, tasks: [shown] }, null, NOW).join("\n")
    ).toMatch(
      /bought sparkleclean\.co\.uk themselves and the registry shows it/
    )
  })

  it("tells a draft waiting from a published site, and Google's turn once a domain connects", () => {
    const waiting = openItems(
      {
        ...EMPTY,
        approvals: [{ version: 1, expires_at: NOW.toISOString() }],
        domains: [
          {
            name: "sparkleclean.co.uk",
            state: "awaiting_dns",
            last_check: null,
          },
        ],
      },
      null,
      NOW
    )
    expect(waiting).toContain("- Website: draft ready, not published.")
    expect(waiting.join("\n")).toMatch(
      /Google: not connected; it can be offered/
    )
    const live = openItems(
      { ...EMPTY, site: { host: "x.reme.site", live_version: 2 } },
      null,
      NOW
    )
    expect(live).toContain("- Website: published.")
  })

  it("rides in the turn's context before the facts", () => {
    const { text } = contextOf(
      "act",
      EMPTY,
      null,
      NOW,
      undefined,
      undefined,
      false,
      null,
      [],
      false,
      null,
      [],
      [],
      openItems(EMPTY, null, NOW)
    )
    expect(text).toMatch(
      /Open items, from the records[\s\S]*<data source="workspace"/
    )
  })
})

describe("the hand-over note", () => {
  it("names what onboarding settled, what was skipped and the address pick", () => {
    const note = handoverNote(
      [
        { id: "work", state: "done" },
        { id: "proof", state: "skipped" },
        { id: "contact", state: "done" },
      ],
      { answer: "later", waiting: null }
    )
    expect(note).toMatch(/Settled: services, contact details\./)
    expect(note).toMatch(
      /Skipped by the owner or left for later: what sets the business apart\./
    )
    expect(note).toMatch(/the owner chose Skip for now\./)
  })
})

describe("the procedures code loads", () => {
  const building = {
    assignment_id: crypto.randomUUID(),
    kind: "site.build" as const,
    state: "implementing" as const,
    lane: "full" as const,
    goal: "Build my website",
    version: null,
  }

  it("loads the top open item's on the hand-over, and what the owner's message is about", () => {
    expect(skillsDue({ workspace: EMPTY, starting: "handover" })).toEqual([
      "web-address",
    ])
    // A new conversation with no site yet has no address to put it on.
    expect(skillsDue({ workspace: EMPTY, starting: "session" })).toEqual([])
    expect(
      skillsDue({
        workspace: { ...EMPTY, site: { host: "x.reme.site", live_version: 1 } },
        starting: "session",
      })
    ).toEqual(["web-address"])
    expect(
      skillsDue({ workspace: EMPTY, said: "Help me set up my web address" })
    ).toEqual(["web-address"])
    expect(skillsDue({ workspace: EMPTY, said: ADDRESS_ASK.no })).toEqual([
      "web-address",
    ])
    expect(
      skillsDue({ workspace: EMPTY, said: "Can I get on Google?" })
    ).toEqual(["google-search"])
    expect(skillsDue({ workspace: EMPTY, said: "Thanks!" })).toEqual([])
  })

  it("loads a task's, a build's and a waiting review's while they are under way, and a schedule's own", () => {
    const choosing = address({
      steps: [step("find_out", "done"), step("choose", "blocked")],
    })
    expect(
      skillsDue({
        workspace: {
          ...EMPTY,
          tasks: [choosing],
          builds: [building],
          approvals: [{ version: 1, expires_at: NOW.toISOString() }],
        },
        scheduled: "weekly-review",
      })
    ).toEqual(["weekly-review", "web-address", "builds", "reviews"])
  })

  it("reads a loaded procedure back as one of the history's events, never the owner's turn", () => {
    const turn = "01JD0000000000000000000000"
    const rows = [
      {
        seq: 0,
        type: "cos.skill",
        payload: { name: "web-address", body: "Web address: the rules." },
      },
      {
        seq: 1,
        type: "cos.message",
        payload: {
          turn_id: turn,
          message: {
            id: "u1",
            role: "user",
            parts: [{ type: "text", text: "Hi" }],
          },
        },
      },
      {
        seq: 2,
        type: "cos.context",
        payload: {
          turn_id: turn,
          prefix_sha256: "a".repeat(64),
          context_policy_version: CONTEXT_POLICY.version,
          mode: "ask",
          active_tools: [],
          text: "Mode: ask.",
          reserved_usd: 0,
        },
      },
    ]
    const { messages } = deriveCosMessages(rows, CONTEXT_POLICY)
    expect(messages.map((m) => m.id)).toEqual([
      "event:0",
      `context-${turn}`,
      "u1",
    ])
    expect(JSON.stringify(messages[0])).toContain(
      "The web-address procedure, loaded by code"
    )
  })
})

describe("the session-start note", () => {
  it("carries the last summary as data, and one proactive line only while the address is open, not put off, and a site exists", () => {
    const live = { ...EMPTY, site: { host: "x.reme.site", live_version: 1 } }
    const note = sessionNote(live, "Talked about <b>prices</b>.")
    expect(note[0]).toMatch(/This is a new conversation/)
    expect(note.join("\n")).toContain(
      '<data source="summary" taint="inferred untrusted_input">'
    )
    expect(note.join("\n")).toContain("\\u003cb>prices")
    expect(note.at(-1)).toMatch(/Want your own address\?[^\n]*call put_off/)
    // Put off, or nothing built yet: no proactive line.
    const later = address({ state: "later", later_until: NOW.toISOString() })
    expect(sessionNote({ ...live, tasks: [later] }, null)).toHaveLength(1)
    expect(sessionNote(EMPTY, null)).toHaveLength(1)
  })
})
