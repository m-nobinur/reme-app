import type { CosWorkspace } from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import { contextOf } from "../src/cos/agent.ts"

const BUILD = "3f2b9c1e-8a4d-4f6b-9c2a-1d5e7f8a9b0d"
const ASKED = "9d1c0a52-7b3e-4e8f-8a61-2c4d5e6f7a8b"

const WORKSPACE: CosWorkspace = {
  site: { host: "spark.example.dev", live_version: 3 },
  builds: [
    {
      assignment_id: BUILD,
      kind: "site.revise",
      state: "blocked_on_information",
      lane: "full",
      goal: "Add a Saturday slot.",
      version: 4,
      fixing: { round: 2, checks: ["types"] },
      progress: [
        { step: "Planning the pages", done: 1, total: 1, now: false },
        { step: "Writing the pages", done: 3, total: 7, now: true },
      ],
    },
  ],
  stopped: [
    {
      cause: "unfinished",
      at: "2026-10-30T08:00:00.000Z",
      checks: ["types", "content", "claims"],
    },
  ],
  questions: [
    {
      request_id: ASKED,
      field: "business.phone",
      why: "The footer shows it.",
      options: null,
      blocking: true,
    },
  ],
  approvals: [{ version: 4, expires_at: "2026-10-30T09:00:00.000Z" }],
  missing_facts: ["hours.weekday", "owner.preferred_name"],
  domains: [
    {
      name: "spark.example.dev",
      state: "awaiting_dns",
      last_check: { status: "pending_verification" },
    },
  ],
  expected_seconds: {
    quick: { p50: 15, p95: 45 },
    full: { p50: 180, p95: 330 },
  },
}

/** The workspace data of a turn's context, as the model reads it. */
const dumped = (workspace: CosWorkspace) => {
  const { text } = contextOf("act", workspace)
  const json = text.split('<data source="workspace"')[1]?.split("\n")[1]
  return JSON.parse(json as string) as unknown
}

/** The same data with every `ref` field taken out. */
const withoutRefs = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutRefs)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "ref")
        .map(([key, inner]) => [key, withoutRefs(inner)])
    )
  }
  return value
}

describe("the workspace the CoS reads", () => {
  it("reads each build's steps and the builds that stopped, in plain words", () => {
    const data = dumped(WORKSPACE) as {
      builds: { progress: string[]; fixing?: string }[]
      stopped_recently: { why: string; failed?: string[] }[]
    }
    expect(data.builds[0]).toMatchObject({
      fixing: "round 2 of fixing the code checks",
    })
    expect(data.builds[0]?.progress).toEqual([
      "Planning the pages (done)",
      "Writing the pages: 3 of 7 (now)",
    ])
    expect(data.stopped_recently[0]).toMatchObject({
      why: "it could not pass its checks",
      failed: ["the code checks", "a claim the facts do not back"],
    })
  })

  it("says how long a build has run, a long quiet and a restart, in plain words", () => {
    const [build] = WORKSPACE.builds
    if (!build) throw new Error("no build")
    const read = (b: Partial<typeof build>) =>
      (
        dumped({ ...WORKSPACE, builds: [{ ...build, ...b }] }) as {
          builds: Record<string, unknown>[]
        }
      ).builds[0]
    expect(
      read({
        timing: { running_minutes: 38, quiet_minutes: 12, overdue: true },
        restarted: { minutes_ago: 2, cause: "stalled", working: true },
      })
    ).toMatchObject({
      running_minutes: 38,
      longer_than_usual: true,
      minutes_since_last_work: 12,
      restarted: {
        minutes_ago: 2,
        why: "it stopped making progress",
        working_again: true,
      },
    })
    // A short quiet is still work, and a build on time says nothing of it.
    const onTime = read({
      timing: { running_minutes: 4, quiet_minutes: 2, overdue: false },
    })
    expect(onTime).toMatchObject({ running_minutes: 4 })
    expect(onTime).not.toHaveProperty("longer_than_usual")
    expect(onTime).not.toHaveProperty("minutes_since_last_work")
  })

  it("holds no id or hash outside a ref", () => {
    const text = JSON.stringify(withoutRefs(dumped(WORKSPACE)))
    expect(text).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    )
    expect(text).not.toMatch(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/i)
  })

  it("holds no version number or raw state", () => {
    const text = JSON.stringify(withoutRefs(dumped(WORKSPACE)))
    expect(text).not.toMatch(/version|live_version/)
    expect(text).not.toMatch(
      /blocked_on_information|awaiting_dns|pending_verification|site\.revise|business\.phone/
    )
  })

  it("keeps what a tool must be given back in a ref", () => {
    expect(dumped(WORKSPACE)).toMatchObject({
      builds: [{ ref: BUILD, state: "waiting on an answer from the owner" }],
      questions: [
        {
          ref: { request_id: ASKED, field: "business.phone" },
          about: "business phone",
        },
      ],
      site: { address: "spark.example.dev", live: true },
    })
  })
})
