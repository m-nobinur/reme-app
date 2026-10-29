import {
  type ActivitySegment,
  CosToolName,
  ONBOARDING_STATUS,
  type OnboardingStatus,
  OnboardingStep,
  PLAN_FACT_KEYS,
  PlanNext,
} from "@workspace/contracts"
import {
  clearOnboardingStatus,
  onboardingStatusNow,
  readOnboardingStatus,
} from "@workspace/ui/hooks/use-onboarding-status"
import {
  type BuildStage,
  type CopyContext,
  type LineState,
  onboardingLine,
  ownerWaits,
  PART_STATES,
  type PartState,
  type Phase,
  partPhase,
  pillLine,
  rowLine,
  STILL_AFTER,
  segmentLine,
  segmentTitle,
  stageLine,
  standingLine,
  stepLabel,
  TURN_ENDS,
  type TurnEnd,
  toolSay,
  trayOthers,
  waitingLine,
} from "@workspace/ui/lib/activity-copy"
import { describe, expect, it } from "vitest"
import { voiceProblems } from "../../../api/src/voice.ts"

/**
 * The status lines as a total function: every tool, step, stage and segment
 * in every state has a line, and random streams (unknown names, aborted
 * turns, errors) never leave an empty, raw or stale one.
 */

const ctx: CopyContext = { seed: "01TURN", assistant: "Wren" }

/** A line the owner may read: words, no dash, none of the product's plumbing. */
function readable(line: string | null | undefined) {
  expect(line).toBeTruthy()
  const text = line as string
  expect(text.trim()).toBe(text)
  expect(voiceProblems(text, { assistantNamed: true }).hard).toEqual([])
}

const ARGS = [
  {},
  {
    domain: "pebblewick.bnwise.tech",
    query: "pebblewick bike fix",
    when: "Friday, 9:00 AM",
    count: 3,
  },
  // What cleanArg refuses: an id, an enum, a hash.
  {
    domain: "",
    query: "0f8f8431-aaaa-bbbb-cccc-1234567890ab",
    when: "due_at_null",
    count: 0,
  },
]
const UNKNOWN = ["send_invoice", "get_calendar", "", "x"]
const WORKING: readonly Phase[] = ["working", "still"]

describe("every tool in every state", () => {
  for (const tool of CosToolName.options) {
    it(`${tool} has its own line for every part state and turn end`, () => {
      for (const state of PART_STATES) {
        for (const turn of TURN_ENDS) {
          for (const args of ARGS) {
            const phase = partPhase(state, turn, 0)
            const { text, level } = toolSay(tool, phase, args, ctx)
            readable(text)
            expect(text).not.toContain(tool)
            // Its own words, except where only the card can say more.
            if (phase !== "waiting" && phase !== "denied") {
              expect(["specific", "plain"]).toContain(level)
            }
          }
        }
      }
    })
  }

  it("names the host when there is one", () => {
    const { text, level } = toolSay(
      "check_domain",
      "working",
      { domain: "pebblewick.bnwise.tech" },
      ctx
    )
    expect(level).toBe("specific")
    expect(text).toMatch(
      /^Checking (the records for )?pebblewick\.bnwise\.tech$/
    )
  })

  it("lands an unknown tool on its kind or the universal line, never its name", () => {
    for (const tool of UNKNOWN) {
      for (const state of PART_STATES) {
        for (const turn of TURN_ENDS) {
          const { text, level } = toolSay(tool, partPhase(state, turn), {}, ctx)
          readable(text)
          if (tool) expect(text).not.toContain(tool)
          expect(["kind", "universal"]).toContain(level)
        }
      }
    }
  })

  it("never says a one-off check stopped the watch on a domain", () => {
    for (const phase of ["stopped", "cut"] as const) {
      const line = toolSay(
        "check_domain",
        phase,
        { domain: "pebblewick.bnwise.tech" },
        ctx
      ).text
      expect(line).toMatch(/this check of pebblewick\.bnwise\.tech$/)
      expect(line).not.toMatch(/^Stopped checking/)
    }
  })

  it("says Still once a tool runs long, and only while its turn runs", () => {
    expect(partPhase("input-available", "running", STILL_AFTER)).toBe("still")
    expect(partPhase("input-available", "running", STILL_AFTER - 1)).toBe(
      "working"
    )
    for (const turn of TURN_ENDS.filter((t) => t !== "running")) {
      for (const state of PART_STATES) {
        expect(WORKING).not.toContain(partPhase(state, turn, 999))
      }
    }
  })
})

describe("every onboarding step, move and fact", () => {
  it("has a line for each step, given or being read", () => {
    for (const step of OnboardingStep.options) {
      for (const answered of [true, false]) {
        readable(onboardingLine({ kind: "step", step, answered }))
      }
    }
    for (const key of PLAN_FACT_KEYS)
      readable(onboardingLine({ kind: "fact", key }))
    for (const option of PlanNext.options) {
      const next = option.shape.kind.value
      if (next === "reopen") continue
      readable(onboardingLine({ kind: "next", next } as OnboardingStatus["on"]))
    }
  })

  it("never shows the model's own words", () => {
    const said = "Reading about your rates — and the van_id"
    expect(onboardingLine({ kind: "doing", text: said })).not.toContain("rates")
    expect(onboardingLine({ kind: "thinking", text: said })).not.toContain(
      "rates"
    )
  })

  it("lands an unknown step or move on a plain line", () => {
    const step = {
      kind: "step",
      step: "business.fax",
      answered: true,
    } as unknown as OnboardingStatus["on"]
    const next = {
      kind: "next",
      next: "ask_fax",
    } as unknown as OnboardingStatus["on"]
    readable(onboardingLine(step))
    readable(onboardingLine(next))
  })
})

describe("every build stage", () => {
  const stages: BuildStage[] = [
    "planning",
    "photos",
    "writing",
    "polishing",
    "checking",
    "ready",
  ]
  const forms: LineState[] = ["working", "done", "failed"]
  it("has a line in every form", () => {
    for (const stage of stages) {
      for (const form of forms) {
        readable(stageLine(stage, form))
        readable(
          stageLine(stage, form, {
            done: 2,
            total: 6,
            fixes: 1,
            working: 2,
            written: ["Home", "About"],
          })
        )
      }
    }
  })
})

const KINDS: ActivitySegment["kind"][] = [
  "onboarding",
  "website",
  "golive",
  "change",
  "address",
  "domain",
  "purchase",
  "google",
  "reminder",
  "review",
  "question",
  "checkin",
  "turn",
]
const STATES: ActivitySegment["state"][] = [
  "now",
  "waiting",
  "upcoming",
  "done",
  "failed",
]
const STEP_IDS = [
  "work",
  "planning",
  "writing",
  "approval",
  "find_out",
  "choose",
  "purchase",
  "records",
  "ownership",
  "certificate",
  "loads",
  "dns",
  "payment",
  "sign_in",
  "permissions",
  "verify",
  "message",
  "unknown_step",
]

const seg = (
  kind: ActivitySegment["kind"],
  state: ActivitySegment["state"],
  stepState: ActivitySegment["steps"][number]["state"] = "waiting"
): ActivitySegment => ({
  id: `${kind}:1`,
  kind,
  state,
  steps: STEP_IDS.slice(0, 4).map((id, i) => ({
    id,
    state: i === 3 ? stepState : "done",
  })),
  at: "2026-10-29T07:00:00.000Z",
  names: {
    domain: "pebblewick.bnwise.tech",
    business: "Pebblewick Mobile Bike Fix",
  },
})

describe("every segment kind and state", () => {
  it("has a clean title, line, pill, row and standing line wherever it has one", () => {
    for (const kind of KINDS) {
      for (const state of STATES) {
        const s = seg(kind, state)
        for (const line of [
          segmentTitle(s, ctx),
          segmentLine(s, ctx),
          pillLine(s, ctx),
          rowLine(s, ctx, "order brake pads"),
        ]) {
          if (line !== null) readable(line)
        }
        readable(standingLine(s, ctx))
      }
    }
  })

  it("labels every known step and leaves an unknown one out", () => {
    for (const kind of KINDS) {
      for (const id of STEP_IDS) {
        const s = seg(kind, "now")
        const label = stepLabel(s, { id, state: "done" })
        if (label !== null) readable(label)
      }
    }
    expect(
      stepLabel(seg("address", "now"), { id: "unknown_step", state: "done" })
    ).toBeNull()
  })

  it("lands a segment kind it does not know on nothing, never on raw text", () => {
    const s = {
      ...seg("address", "now"),
      kind: "calendar",
    } as unknown as ActivitySegment
    expect(segmentTitle(s, ctx)).toBeNull()
    expect(pillLine(s, ctx)).toBeNull()
    readable(standingLine(s, ctx))
  })
})

describe("what waits on the owner", () => {
  it("titles every wait it can meet, and names the domain", () => {
    for (const kind of KINDS) {
      for (const id of STEP_IDS) {
        const s: ActivitySegment = {
          ...seg(kind, "waiting"),
          steps: [{ id, state: "waiting" }],
        }
        const [wait] = ownerWaits({
          journey: [],
          now: [],
          waiting: [s],
          upcoming: [],
          done: [],
        })
        readable(wait?.title)
        readable(wait?.what)
      }
    }
    const dns: ActivitySegment = {
      ...seg("address", "waiting"),
      steps: [{ id: "records", state: "waiting" }],
    }
    expect(
      ownerWaits({
        journey: [],
        now: [],
        waiting: [dns],
        upcoming: [],
        done: [],
      })[0]?.title
    ).toBe("Make the DNS change for pebblewick.bnwise.tech")
  })

  it("follows the furthest step, so a stale choice never stands for the DNS change", () => {
    const stale: ActivitySegment = {
      ...seg("address", "waiting"),
      steps: [
        { id: "find_out", state: "done" },
        { id: "choose", state: "waiting" },
        { id: "purchase", state: "skipped" },
        { id: "records", state: "waiting" },
      ],
    }
    expect(pillLine(stale, ctx)).toBe("Wren is waiting for your DNS change")
    expect(segmentTitle(stale, ctx)).toMatch(/pebblewick\.bnwise\.tech/)
    const choosing: ActivitySegment = {
      ...stale,
      state: "now",
      steps: [
        { id: "find_out", state: "done" },
        { id: "choose", state: "now" },
        { id: "purchase", state: "next" },
        { id: "records", state: "next" },
      ],
    }
    expect(segmentTitle(choosing, ctx)).toMatch(
      /^(Choosing your web address|Picking a name for your website)$/
    )
  })

  it("says what else waits in the tray", () => {
    expect(trayOthers(["create-reminder"])).toBe("also a reminder")
    expect(trayOthers(["buy-domain", "ask-fact"])).toBe(
      "also your domain payment and a question"
    )
    readable(trayOthers(["something-new"]))
  })
})

// ---------------------------------------------------------------------------
// Random streams: what the thread shows over many turns.

/** A small seeded generator, so a failure replays. */
function random(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const STATUSES: OnboardingStatus["on"][] = [
  { kind: "step", step: "contact", answered: true },
  { kind: "reading", about: "answer" },
  { kind: "fact", key: "business.offerings" },
  { kind: "next", next: "ask_open" },
  { kind: "doing", text: "Model words that must not show" },
  { kind: "thinking", text: "A reasoning heading" },
]

type Part = { tool: string; state: PartState; args: (typeof ARGS)[number] }

describe("random streams", () => {
  it("never shows an empty, raw or stale line, or work after its turn", () => {
    const tools = [...CosToolName.options, ...UNKNOWN.filter(Boolean)]
    for (let run = 0; run < 300; run++) {
      const next = random(run + 1)
      const one = <T>(list: readonly T[]) =>
        list[Math.floor(next() * list.length)] as T
      const earlier: string[] = []
      clearOnboardingStatus()
      for (let t = 0; t < 4; t++) {
        const turn = {
          seed: `01RUN${run}T${t}`,
          earlier: [...earlier],
          assistant: one(["Wren", null]),
        }
        // A new turn starts with no status: the last turn's is gone.
        clearOnboardingStatus()
        expect(onboardingStatusNow()).toBeNull()
        const start = waitingLine(onboardingStatusNow(), 0, turn)
        readable(start.label)
        const statusLines = new Set(STATUSES.map((on) => onboardingLine(on)))
        expect(statusLines.has(start.label)).toBe(false)

        const parts: Part[] = []
        const events = 1 + Math.floor(next() * 8)
        for (let e = 0; e < events; e++) {
          const roll = next()
          if (roll < 0.3) {
            readOnboardingStatus(
              {
                type: ONBOARDING_STATUS,
                data: { on: one(STATUSES), facts: [] },
              },
              () => undefined
            )
          } else if (roll < 0.6 || parts.length === 0) {
            parts.push({
              tool: one(tools),
              state: "input-streaming",
              args: one(ARGS),
            })
          } else {
            const part = one(parts)
            part.state = one(PART_STATES)
          }
          const seconds = Math.floor(next() * 40)
          for (const part of parts) {
            readable(
              toolSay(
                part.tool,
                partPhase(part.state, "running", seconds),
                part.args,
                turn
              ).text
            )
          }
          readable(waitingLine(onboardingStatusNow(), seconds, turn).label)
        }

        const end: TurnEnd = one(TURN_ENDS.filter((each) => each !== "running"))
        // The runtime clears the status when a turn finishes or fails; a
        // cancelled one is cleared by the next send.
        if (end !== "cancelled") clearOnboardingStatus()
        for (const part of parts) {
          const phase = partPhase(part.state, end, 999)
          expect(WORKING).not.toContain(phase)
          const { text } = toolSay(part.tool, phase, part.args, turn)
          readable(text)
          expect(text).not.toBe(
            toolSay(part.tool, "working", part.args, turn).text
          )
          expect(text).not.toMatch(/^Still /)
        }
        earlier.push(turn.seed)
      }
    }
  })
})
