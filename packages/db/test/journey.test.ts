import type { OwnerTask } from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import {
  type JourneyCard,
  type JourneyInput,
  journeyOf,
  type Latch,
} from "../src/journey.ts"

const NOW = new Date("2026-11-05T23:30:00.000Z")
const ago = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString()
const HERE = "11111111-1111-4111-8111-111111111111"
const OTHER = "22222222-2222-4222-8222-222222222222"
const TASK = "33333333-3333-4333-8333-333333333333"

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
const address = (over: Record<string, unknown> = {}): OwnerTask =>
  ({
    id: TASK,
    kind: "address",
    state: "active",
    later_until: null,
    created_at: ago(600),
    done_at: null,
    detail: {},
    steps: [],
    ...over,
  }) as OwnerTask
const google = (over: Record<string, unknown> = {}): OwnerTask =>
  ({
    id: "44444444-4444-4444-8444-444444444444",
    kind: "google",
    state: "active",
    later_until: null,
    created_at: ago(600),
    done_at: null,
    detail: {},
    steps: [],
    ...over,
  }) as OwnerTask

const DRAFT = {
  live: false,
  building: false,
  drafts: [{ id: "r1", at: ago(20) }],
}
const card = (over: Partial<JourneyCard> = {}): JourneyCard => ({
  answer: null,
  waiting: "have",
  shown_at: ago(5),
  ...over,
})
/** The owner wrote a minute ago in this conversation: the same sitting. */
const sameSitting = {
  conversation: HERE,
  recent: [
    { at: ago(1), conversation: HERE },
    { at: ago(10), conversation: HERE },
  ],
}
const journey = (over: Partial<JourneyInput> = {}) =>
  journeyOf({ tasks: [], website: DRAFT, now: NOW, ...over })

describe("journeyOf: stages", () => {
  it("reads the website from live, drafts and builds", () => {
    expect(journey().website).toBe("draft_ready")
    expect(
      journey({ website: { live: true, building: false, drafts: [] } }).website
    ).toBe("published")
    expect(
      journey({ website: { live: false, building: true, drafts: [] } }).website
    ).toBe("building")
    expect(
      journey({ website: { live: false, building: false, drafts: [] } }).website
    ).toBe("none")
  })

  it("offers Connect while the address is the owner's to start, and Connect for a bought name", () => {
    const offer = (tasks: OwnerTask[]) => journey({ tasks }).address
    expect(offer([])).toEqual({ stage: "none", offer: "connect" })
    expect(
      offer([address({ steps: [step("find_out", "pending")] })]).offer
    ).toBe("connect")
    expect(
      offer([
        address({
          steps: [step("find_out", "done"), step("choose", "blocked")],
        }),
      ])
    ).toEqual({ stage: "choosing", offer: "connect" })
    expect(
      offer([
        address({
          detail: { name: "x.co.uk", origin: "buying_elsewhere" },
          steps: [step("purchase", "blocked")],
        }),
      ])
    ).toEqual({ stage: "buying_elsewhere", name: "x.co.uk", offer: "connect" })
    expect(
      offer([
        address({
          detail: { name: "x.co.uk", origin: "buying_elsewhere" },
          steps: [step("purchase", "done")],
        }),
      ])
    ).toEqual({ stage: "bought", name: "x.co.uk", offer: "connect_bought" })
    expect(
      offer([address({ state: "later", later_until: ago(-60) })]).offer
    ).toBeNull()
    expect(offer([address({ state: "declined" })]).offer).toBeNull()
    expect(
      offer([
        address({
          detail: { name: "x.co.uk" },
          steps: [step("find_out", "done")],
        }),
      ])
    ).toEqual({ stage: "connecting", name: "x.co.uk", offer: null })
    expect(
      offer([address({ state: "done", detail: { name: "x.co.uk" } })]).offer
    ).toBeNull()
  })

  it("puts Google after the address, and follows its task", () => {
    const connecting = address({
      detail: { name: "x.co.uk" },
      steps: [step("find_out", "done")],
    })
    expect(journey().google).toBe("waiting_for_domain")
    expect(journey({ tasks: [connecting] }).google).toBe("offerable")
    expect(journey({ tasks: [connecting, google()] }).google).toBe("setting_up")
    expect(
      journey({ tasks: [connecting, google({ state: "done" })] }).google
    ).toBe("connected")
    expect(
      journey({ tasks: [connecting, google({ state: "declined" })] }).google
    ).toBe("declined")
    expect(
      journey({
        tasks: [connecting, google({ state: "later", later_until: ago(-60) })],
      }).google
    ).toBe("put_off")
    expect(
      journey({
        tasks: [connecting, google({ state: "later", later_until: ago(60) })],
      }).google
    ).toBe("offerable")
  })
})

describe("journeyOf: the card", () => {
  it("waits while shown, asks for the name after Yes, and settles on Skip, No or an answer in words", () => {
    expect(journey({ card: card() }).waiting).toBe("have")
    const yes = [address({ steps: [step("find_out", "pending")] })]
    expect(
      journey({ tasks: yes, card: card({ answer: "yes", waiting: "name" }) })
        .waiting
    ).toBe("name")
    expect(
      journey({
        tasks: [address({ state: "later", later_until: ago(-60) })],
        card: card({ answer: "later", waiting: null }),
      }).waiting
    ).toBeNull()
    // Answered in words: the stage moved, though the card was never tapped.
    const inWords = [
      address({
        detail: { name: "x.co.uk" },
        steps: [step("find_out", "done")],
      }),
    ]
    expect(journey({ tasks: inWords, card: card() }).waiting).toBeNull()
    // No, help me get one, typed rather than tapped.
    const choosing = [
      address({ steps: [step("find_out", "done"), step("choose", "blocked")] }),
    ]
    expect(journey({ tasks: choosing, card: card() }).waiting).toBeNull()
  })
})

describe("journeyOf: bring-backs and their latches", () => {
  const latch = (minutes: number): Latch => ({
    key: `bring_back:${ago(minutes)}`,
    at: ago(minutes),
  })

  it("brings a waiting card back after an aside, at most twice in the sitting it was shown in", () => {
    const first = journey({ card: card(), visit: sameSitting })
    expect(first.bring_back).toBe("aside")
    expect(first.record).toEqual([`bring_back:${NOW.toISOString()}`])
    expect(
      journey({ card: card(), visit: sameSitting, latches: [latch(2)] })
        .bring_back
    ).toBe("aside")
    expect(
      journey({
        card: card(),
        visit: sameSitting,
        latches: [latch(3), latch(2)],
      }).bring_back
    ).toBeNull()
  })

  it("counts the latch written with the message that began the sitting", () => {
    const begun = {
      conversation: HERE,
      recent: [
        { at: ago(1), conversation: HERE },
        { at: ago(2), conversation: HERE },
      ],
    }
    const shown = card({ shown_at: ago(2) })
    expect(
      journey({ card: shown, visit: begun, latches: [latch(2), latch(1)] })
        .bring_back
    ).toBeNull()
    // One from an earlier sitting a moment before does not count.
    const before = {
      key: "bring_back:x",
      at: new Date(Date.parse(ago(2)) - 50).toISOString(),
    }
    expect(
      journey({ card: shown, visit: begun, latches: [before, latch(1)] })
        .bring_back
    ).toBe("aside")
  })

  it("brings it back once in a new sitting", () => {
    const back = {
      conversation: HERE,
      recent: [{ at: ago(180), conversation: HERE }],
    }
    const shown = card({ shown_at: ago(200) })
    expect(
      journey({ card: shown, visit: back, latches: [latch(190), latch(185)] })
        .bring_back
    ).toBe("aside")
    const later = {
      conversation: HERE,
      recent: [
        { at: ago(1), conversation: HERE },
        { at: ago(180), conversation: HERE },
      ],
    }
    expect(
      journey({ card: shown, visit: later, latches: [latch(1)] }).bring_back
    ).toBeNull()
  })

  it("brings an open address back on a return when no card is on screen, and not on the next message", () => {
    const tasks = [address({ steps: [step("find_out", "pending")] })]
    const away = {
      conversation: OTHER,
      recent: [{ at: ago(10), conversation: HERE }],
    }
    expect(journey({ tasks, visit: away }).bring_back).toBe("return")
    expect(journey({ tasks, visit: sameSitting }).bring_back).toBeNull()
  })

  it("never brings back a skipped or declined address, nor for a turn nobody typed", () => {
    const back = {
      conversation: OTHER,
      recent: [{ at: ago(180), conversation: HERE }],
    }
    expect(
      journey({
        tasks: [address({ state: "later", later_until: ago(-60) })],
        visit: back,
      }).bring_back
    ).toBeNull()
    expect(
      journey({ tasks: [address({ state: "declined" })], visit: back })
        .bring_back
    ).toBeNull()
    expect(journey({ card: card() }).bring_back).toBeNull()
  })

  it("waits for a site or a card before bringing an address up", () => {
    const back = {
      conversation: OTHER,
      recent: [{ at: ago(180), conversation: HERE }],
    }
    const nothing = { live: false, building: false, drafts: [] }
    expect(journey({ website: nothing, visit: back }).bring_back).toBeNull()
  })
})

describe("journeyOf: the sitting and what changed", () => {
  const bought = address({
    detail: { name: "sparkleclean.co.uk", origin: "buying_elsewhere" },
    steps: [step("purchase", "done", ago(30))],
  })
  const back = {
    conversation: HERE,
    recent: [{ at: ago(180), conversation: HERE }],
  }

  it("starts a sitting after 30 minutes or in a new conversation, and measures the time away", () => {
    expect(journey({ visit: back }).sitting).toEqual({
      fresh: true,
      away_ms: 180 * 60_000,
      since: NOW.toISOString(),
    })
    expect(
      journey({
        visit: {
          conversation: OTHER,
          recent: [{ at: ago(5), conversation: HERE }],
        },
      }).sitting?.fresh
    ).toBe(true)
    const run = {
      conversation: HERE,
      recent: [
        { at: ago(1), conversation: HERE },
        { at: ago(20), conversation: HERE },
        { at: ago(90), conversation: HERE },
      ],
    }
    expect(journey({ visit: run }).sitting).toEqual({
      fresh: false,
      away_ms: 60_000,
      since: ago(20),
    })
    expect(
      journey({ visit: { conversation: HERE, recent: [] } }).sitting?.fresh
    ).toBe(true)
  })

  it("lists what changed while away, oldest first, and records each to tell it once", () => {
    const live = google({ state: "done", done_at: ago(10) })
    const state = journey({ tasks: [bought, live], visit: back })
    expect(state.changes).toEqual(
      [
        { key: "draft:r1", kind: "draft_ready", at: ago(20) },
        {
          key: `bought:${TASK}`,
          kind: "bought",
          at: ago(30),
          name: "sparkleclean.co.uk",
        },
        {
          key: expect.stringMatching(/^google:/),
          kind: "google_connected",
          at: ago(10),
        },
      ].sort((a, b) => (a.at < b.at ? -1 : 1))
    )
    expect(state.record).toEqual(
      expect.arrayContaining(["told:draft:r1", `told:bought:${TASK}`])
    )
    const told = state.record.map((key) => ({ key, at: NOW.toISOString() }))
    expect(
      journey({ tasks: [bought, live], visit: back, latches: told }).changes
    ).toEqual([])
  })

  it("tells nothing within a sitting, nor what happened before the owner left", () => {
    expect(journey({ tasks: [bought], visit: sameSitting }).changes).toEqual([])
    // A new conversation 25 minutes after leaving: the name was bought before they left.
    const before = {
      conversation: OTHER,
      recent: [{ at: ago(25), conversation: HERE }],
    }
    expect(
      journey({ tasks: [bought], visit: before }).changes.map((c) => c.kind)
    ).toEqual(["draft_ready"])
  })

  it("tells a domain going live", () => {
    const live = address({
      state: "done",
      done_at: ago(60),
      detail: { name: "sparkleclean.co.uk" },
    })
    expect(
      journey({
        tasks: [live],
        website: { live: true, building: false, drafts: [] },
        visit: back,
      }).changes
    ).toEqual([
      {
        key: `live:${TASK}`,
        kind: "live",
        at: ago(60),
        name: "sparkleclean.co.uk",
      },
    ])
  })
})
