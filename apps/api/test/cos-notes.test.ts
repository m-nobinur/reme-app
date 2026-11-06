import {
  ADDRESS_ASK,
  AddressStageName,
  addressQuestions,
  type CosWorkspace,
  type OwnerTask,
} from "@workspace/contracts"
import { type JourneyInput, journeyOf, offerOf } from "@workspace/db"
import { describe, expect, it } from "vitest"
import { contextOf } from "../src/cos/agent.ts"
import { CONTEXT_POLICY, deriveCosMessages } from "../src/cos/history.ts"
import {
  ASIDE_LINE,
  cardState,
  handoverNote,
  leftOutLine,
  NEWS_RULE,
  openItems,
  RETURN_LINE,
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

const step = (
  name: string,
  state: string,
  changed_at: string | null = null
) => ({
  step: name,
  state,
  note: null,
  blocked_on: state === "blocked" ? "owner_action" : null,
  deadline: null,
  changed_at,
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
        step("purchase", "blocked"),
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

  it("does not ask again once the owner said they bought it and the registry is yet to show it", () => {
    const said = address({
      detail: { name: "sparkleclean.co.uk", origin: "buying_elsewhere" },
      steps: [
        step("find_out", "done"),
        step("choose", "done"),
        step("purchase", "in_progress"),
      ],
    })
    const text = openItems({ ...EMPTY, tasks: [said] }, null, NOW).join("\n")
    expect(text).toMatch(
      /says they bought sparkleclean\.co\.uk; the registry does not show it yet/
    )
    expect(text).toMatch(/never ask whether they bought it/)
    expect(text).not.toMatch(/call domain_bought/)
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
        tasks: [
          address({
            detail: { name: "sparkleclean.co.uk" },
            steps: [step("find_out", "done"), step("records", "blocked")],
          }),
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

describe("the skills code loads", () => {
  const yes = { answer: "yes" as const, waiting: null }
  const no = { answer: "no" as const, waiting: null }

  it("loads on explicit triggers only, never from the owner's words or the workspace", () => {
    expect(skillsDue({ handover: true })).toEqual([
      { name: "web-address", trigger: "handover" },
    ])
    expect(skillsDue({ intent: "connect_address" })).toEqual([
      { name: "web-address", trigger: "connect_address" },
    ])
    expect(skillsDue({ intent: "connect_google" })).toEqual([
      { name: "google-search", trigger: "connect_google" },
    ])
    expect(skillsDue({ scheduled: "weekly-review" })).toEqual([
      { name: "weekly-review", trigger: "schedule" },
    ])
    // Words alone, however close, load nothing: the model views what it needs.
    expect(skillsDue({ said: "Help me set up my web address" })).toEqual([])
    expect(skillsDue({ said: "Can I get on Google?" })).toEqual([])
    expect(skillsDue({ said: ADDRESS_ASK.no })).toEqual([])
    expect(skillsDue({})).toEqual([])
  })

  it("loads the matching part for the address card's answer, only with the card's own reply", () => {
    expect(skillsDue({ card: no, said: ADDRESS_ASK.no })).toEqual([
      { name: "web-address", trigger: "address_no" },
      { name: "web-address", part: "buy-new", trigger: "address_no" },
    ])
    for (const said of [ADDRESS_ASK.yes, "Yes, it's sparkleclean.co.uk"]) {
      expect(skillsDue({ card: yes, said })).toEqual([
        { name: "web-address", trigger: "address_yes" },
        { name: "web-address", part: "connect-own", trigger: "address_yes" },
      ])
    }
    // A typed message after the card was answered is the owner's own words.
    expect(skillsDue({ card: no, said: "What does a domain cost?" })).toEqual(
      []
    )
    expect(skillsDue({ card: yes, said: ADDRESS_ASK.no })).toEqual([])
  })

  it("reads a loaded skill back after the owner's message, as a skill_view call and its result", () => {
    const turn = "01JD0000000000000000000000"
    const rows = [
      {
        seq: 0,
        type: "cos.message",
        payload: {
          turn_id: turn,
          message: {
            id: "u1",
            role: "user",
            parts: [{ type: "text", text: ADDRESS_ASK.no }],
          },
        },
      },
      {
        seq: 1,
        type: "cos.skill",
        payload: {
          name: "web-address",
          part: "buy-new",
          body: "# Finding and buying a name",
          status: "Drawing on my domain expertise to find a name",
          trigger: "address_no",
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
      `context-${turn}`,
      "u1",
      "event:1",
    ])
    expect(messages[2]).toMatchObject({
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "tool-skill_view",
          toolCallId: "skill:1",
          state: "output-available",
          input: { name: "web-address", part: "buy-new" },
          output: {
            outcome: "skill",
            name: "web-address",
            part: "buy-new",
            by: "code",
          },
        },
      ],
    })
    expect(JSON.stringify(messages[2])).not.toContain("address_no")
  })
})

describe("the session-start note", () => {
  it("carries the last summary as data, and leaves bringing the address up to the journey", () => {
    const note = sessionNote("Talked about <b>prices</b>.")
    expect(note[0]).toMatch(/This is a new conversation/)
    expect(note.join("\n")).toContain(
      '<data source="summary" taint="inferred untrusted_input">'
    )
    expect(note.join("\n")).toContain("\\u003cb>prices")
    expect(note.join("\n")).not.toMatch(/web address/)
    expect(sessionNote(null)).toHaveLength(1)
  })
})

describe("the journey's lines", () => {
  const HERE = "11111111-1111-4111-8111-111111111111"
  const DRAFT = {
    ...EMPTY,
    approvals: [{ version: 1, expires_at: NOW.toISOString() }],
  }
  const ago = (minutes: number) =>
    new Date(NOW.getTime() - minutes * 60_000).toISOString()
  const card = { answer: null, waiting: "have" as const, shown_at: ago(5) }
  const turn = (over: Partial<JourneyInput> = {}, workspace = DRAFT) => {
    const journey = journeyOf({
      tasks: workspace.tasks ?? [],
      website: {
        live: false,
        building: false,
        drafts: [{ id: "r1", at: ago(20) }],
      },
      now: NOW,
      ...over,
    })
    return {
      journey,
      lines: openItems(
        workspace,
        over.card ?? null,
        NOW,
        "Europe/London",
        journey
      ),
    }
  }
  const sitting = {
    conversation: HERE,
    recent: [
      { at: ago(1), conversation: HERE },
      { at: ago(10), conversation: HERE },
    ],
  }

  const STAGES: Record<AddressStageName, OwnerTask[]> = {
    none: [],
    unknown: [address({ steps: [step("find_out", "pending")] })],
    put_off: [
      address({ state: "later", later_until: "2026-11-12T10:00:00.000Z" }),
    ],
    declined: [address({ state: "declined" })],
    choosing: [
      address({ steps: [step("find_out", "done"), step("choose", "blocked")] }),
    ],
    paying: [
      address({
        detail: { name: "x.co.uk" },
        steps: [{ ...step("purchase", "blocked"), blocked_on: "purchase" }],
      }),
    ],
    buying_elsewhere: [
      address({
        detail: { name: "x.co.uk", origin: "buying_elsewhere" },
        steps: [step("purchase", "blocked")],
      }),
    ],
    bought: [
      address({
        detail: { name: "x.co.uk", origin: "buying_elsewhere" },
        steps: [step("purchase", "done")],
      }),
    ],
    connecting: [
      address({
        detail: { name: "x.co.uk" },
        steps: [step("find_out", "done")],
      }),
    ],
    live: [address({ state: "done", detail: { name: "x.co.uk" } })],
  }

  it("gives an open address its next step and skill part, exactly where the draft-ready line offers Connect", () => {
    const parts: Partial<Record<AddressStageName, string>> = {
      none: "Next: view web-address.",
      unknown: "Next: view web-address.",
      choosing: "Next: view web-address, buy-new.",
      buying_elsewhere: "Next: view web-address, bought-elsewhere.",
      bought: "Next: view web-address, connect-own.",
    }
    for (const stage of AddressStageName.options) {
      const { journey, lines } = turn(
        { tasks: STAGES[stage] },
        { ...DRAFT, tasks: STAGES[stage] }
      )
      expect(journey.address.stage, stage).toBe(stage)
      const line = lines.find((l) => l.startsWith("- Web address:")) ?? ""
      expect(line.includes("Next:"), stage).toBe(offerOf(stage) !== null)
      if (parts[stage])
        expect(line.endsWith(parts[stage] as string), stage).toBe(true)
    }
    const yes = openItems(EMPTY, { answer: "yes", waiting: null }, NOW)
    expect(yes.join("\n")).toMatch(/Next: view web-address, connect-own\./)
  })

  it("points Google's next step at its connect part only once it can be offered", () => {
    const connecting = { ...DRAFT, tasks: STAGES.connecting }
    expect(
      turn({ tasks: STAGES.connecting }, connecting).lines.join("\n")
    ).toMatch(/it can be offered now[^\n]*Next: view google-search, connect\./)
    expect(turn().lines.join("\n")).not.toMatch(/google-search/)
  })

  it("brings a waiting card back after an aside once a sitting, then leaves it to the stack", () => {
    const first = turn({ card, visit: sitting })
    expect(first.lines).toContain(ASIDE_LINE)
    expect(first.lines).toContain(
      "- On screen: the address card asks whether the owner has a web address; they answer it there."
    )
    const latch = (minutes: number) => ({
      key: `bring_back:${ago(minutes)}`,
      at: ago(minutes),
    })
    expect(
      turn({ card, visit: sitting, latches: [latch(2)] }).lines
    ).not.toContain(ASIDE_LINE)
    // A turn nobody typed brings nothing back.
    expect(turn({ card }).lines).not.toContain(ASIDE_LINE)
  })

  it("settles the card once the owner answers it in words", () => {
    const { lines } = turn(
      { card, visit: sitting, tasks: STAGES.connecting },
      { ...DRAFT, tasks: STAGES.connecting }
    )
    expect(lines.join("\n")).toMatch(/No question card waits on screen/)
    expect(lines).not.toContain(ASIDE_LINE)
  })

  it("brings an open address up once on a return, and never after Skip or No", () => {
    const back = {
      conversation: HERE,
      recent: [{ at: ago(180), conversation: HERE }],
    }
    expect(turn({ visit: back }).lines).toContain(RETURN_LINE)
    for (const stage of ["put_off", "declined"] as const)
      expect(
        turn(
          { visit: back, tasks: STAGES[stage] },
          { ...DRAFT, tasks: STAGES[stage] }
        ).lines,
        stage
      ).not.toContain(RETURN_LINE)
  })

  it("tells what changed while the owner was away in one line, once", () => {
    const back = {
      conversation: HERE,
      recent: [{ at: ago(180), conversation: HERE }],
    }
    const bought = [
      address({
        detail: { name: "sparkleclean.co.uk", origin: "buying_elsewhere" },
        steps: [step("purchase", "done", ago(10))],
      }),
    ]
    const away = turn(
      { visit: back, tasks: bought },
      { ...DRAFT, tasks: bought }
    )
    expect(away.lines).toContain(
      `The owner was last here 3 hours ago. Since then: the draft became ready at 9:40 AM, and sparkleclean.co.uk shows as registered. ${NEWS_RULE}`
    )
    const told = away.journey.record.map((key) => ({
      key,
      at: NOW.toISOString(),
    }))
    expect(
      turn(
        { visit: back, tasks: bought, latches: told },
        { ...DRAFT, tasks: bought }
      ).lines.join("\n")
    ).not.toMatch(/last here/)
    expect(
      turn(
        { visit: sitting, tasks: bought },
        { ...DRAFT, tasks: bought }
      ).lines.join("\n")
    ).not.toMatch(/last here/)
  })

  it("leads with a draft ready or a build stopped since the owner last wrote, within a sitting too", () => {
    const ready = turn({
      visit: sitting,
      website: {
        live: false,
        building: false,
        drafts: [{ id: "r2", at: ago(0.5) }],
      },
    })
    expect(ready.lines).toContain(
      `Since the owner last wrote: the draft became ready at 9:59 AM. ${NEWS_RULE}`
    )
    expect(ready.journey.record).toEqual(["told:draft:r2"])
    const stopped = turn(
      {
        visit: sitting,
        website: {
          live: false,
          building: false,
          drafts: [],
          stopped: [ago(0.5)],
        },
      },
      EMPTY
    )
    expect(stopped.lines).toContain(
      `Since the owner last wrote: the website build stopped at 9:59 AM and waits for them to say try again. ${NEWS_RULE}`
    )
    // Said once: with its latch, the next message hears nothing of it.
    const told = ready.journey.record.map((key) => ({
      key,
      at: NOW.toISOString(),
    }))
    expect(
      turn({
        visit: sitting,
        latches: told,
        website: {
          live: false,
          building: false,
          drafts: [{ id: "r2", at: ago(0.5) }],
        },
      }).lines.join("\n")
    ).not.toMatch(/Since the owner last wrote/)
  })

  it("says what the newest draft left out in its own line, on up to three turns", () => {
    const website = {
      live: false,
      building: false,
      drafts: [
        {
          id: "r1",
          at: ago(20),
          left_out: ["Are you insured?", "Do you offer a guarantee?"],
        },
      ],
    }
    const first = turn({ website, visit: sitting })
    expect(first.lines.at(-1)).toBe(
      "The draft left out: Are you insured? Do you offer a guarantee? Mention it once, in one line, the next time the owner talks about the website, and offer to add them; if one of your replies already did, say nothing about it."
    )
    expect(first.lines).toContain(leftOutLine(first.journey.left_out))
    const latches = [1, 2, 3].map((n) => ({
      key: `told:left_out:r1:${n}`,
      at: ago(1),
    }))
    expect(
      turn({ website, visit: sitting, latches }).lines.join("\n")
    ).not.toContain("The draft left out")
  })
})
