import { ErrorEnvelope } from "@workspace/contracts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import worker from "../src/index.ts"
import { type ChangeInput, routeChange } from "../src/owner.ts"
import { etag, unchanged } from "../src/workspace.ts"
import { env, stubJwksFetch } from "./sealed-session.ts"

/**
 * The owner routes' pure halves: where a change goes, the workspace tag, and
 * refusals that happen before any database or binding is touched.
 */

const A = "00000000-0000-4000-8000-00000000000a"
const B = "00000000-0000-4000-8000-00000000000b"
const R = "00000000-0000-4000-8000-0000000000aa"

const site = (over: Partial<ChangeInput> = {}): ChangeInput => ({
  live: false,
  builds: [],
  reviews: [],
  ...over,
})

describe("routeChange, row by row", () => {
  it("builds an unpublished site with nothing running", () => {
    expect(routeChange(site())).toEqual({ route: "build" })
  })

  it("revises a live site with nothing running", () => {
    expect(routeChange(site({ live: true }))).toEqual({ route: "revise" })
  })

  it("steers a build that is still working", () => {
    for (const state of [
      "briefing",
      "planning",
      "implementing",
      "validating",
      "repairing",
      "revising",
    ] as const) {
      expect(
        routeChange(site({ builds: [{ assignment_id: A, state }] }))
      ).toEqual({ route: "steer", assignment_id: A })
    }
  })

  it("refuses while a question is open, ahead of everything else", () => {
    expect(
      routeChange(
        site({
          live: true,
          builds: [
            { assignment_id: A, state: "awaiting_review" },
            { assignment_id: B, state: "blocked_on_information" },
          ],
          reviews: [{ assignment_id: A, revision_id: R }],
        })
      )
    ).toEqual({ route: "refuse", reason: "question_open", assignment_id: B })
  })

  it("turns down an open review, then builds or revises", () => {
    const reviewing = {
      builds: [{ assignment_id: A, state: "awaiting_review" as const }],
      reviews: [{ assignment_id: A, revision_id: R }],
    }
    expect(routeChange(site(reviewing))).toEqual({
      route: "reject_then_rebuild",
      assignment_id: A,
      revision_id: R,
      rebuild: "site.build",
    })
    expect(routeChange(site({ ...reviewing, live: true }))).toMatchObject({
      route: "reject_then_rebuild",
      rebuild: "site.revise",
    })
  })

  it("refuses a build that is past working and not under review", () => {
    for (const state of [
      "queued",
      "preview_ready",
      "awaiting_review",
      "release_candidate",
      "blocked_on_approval",
      "paused",
    ] as const) {
      expect(
        routeChange(site({ builds: [{ assignment_id: A, state }] }))
      ).toEqual({ route: "refuse", reason: "build_busy", assignment_id: A })
    }
  })

  it("steers the working build when a newer one is queued behind it", () => {
    expect(
      routeChange(
        site({
          builds: [
            { assignment_id: B, state: "queued" },
            { assignment_id: A, state: "implementing" },
          ],
        })
      )
    ).toEqual({ route: "steer", assignment_id: A })
  })
})

describe("the workspace tag", () => {
  it("is the same for the same body and differs for another", async () => {
    const one = await etag('{"a":1}')
    expect(await etag('{"a":1}')).toBe(one)
    expect(await etag('{"a":2}')).not.toBe(one)
    expect(one).toMatch(/^"[0-9a-f]{32}"$/)
  })

  it("matches If-None-Match lists and weak forms, and nothing else", () => {
    expect(unchanged('"x"', '"x"')).toBe(true)
    expect(unchanged('"y", W/"x"', '"x"')).toBe(true)
    expect(unchanged('"y"', '"x"')).toBe(false)
    expect(unchanged(null, '"x"')).toBe(false)
  })
})

describe("owner routes refuse before the database", () => {
  let realFetch: typeof fetch
  beforeAll(() => {
    realFetch = globalThis.fetch
    globalThis.fetch = stubJwksFetch()
  })
  afterAll(() => {
    globalThis.fetch = realFetch
  })

  const calls: Request[] = []
  const ctx = { waitUntil: () => undefined } as unknown as ExecutionContext

  it.each([
    ["GET", "/workspace"],
    ["GET", "/facts"],
    ["POST", "/facts"],
    ["POST", "/changes"],
    ["GET", "/activity"],
    ["POST", `/builds/${A}/answer`],
    ["POST", `/builds/${A}/cancel`],
    ["GET", `/builds/${A}/preview`],
    ["POST", `/approvals/${A}/decision`],
  ])("%s %s with no session is 401", async (method, path) => {
    const response = await worker.fetch(
      new Request(`http://api.invalid${path}`, { method }),
      {
        ...env("postgresql://127.0.0.1:1/none"),
        ORCHESTRATOR: { fetch: (r: Request) => calls.push(r) },
      } as unknown as Env,
      ctx
    )
    expect(response.status).toBe(401)
    expect(ErrorEnvelope.parse(await response.json()).code).toBe(
      "session.absent"
    )
    expect(calls).toHaveLength(0)
  })
})
