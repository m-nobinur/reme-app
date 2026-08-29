import { ErrorEnvelope, Org, StaffDirectory } from "@workspace/contracts"
import { GOLDEN_ORGS } from "@workspace/db/fixtures"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import worker from "../src/index.ts"
import { cookieHeader, env, stubJwksFetch } from "../test/sealed-session.ts"

/**
 * Cross-org denial through the authenticated API. Part of the blocking tenancy
 * gate: `pnpm test:tenancy` runs this directory after `packages/db`'s.
 *
 * The gate already proved cross-org denial twice, through raw SQL and through
 * `withOrg`. Both stop one line below where an org id is decided. This is the
 * line above: a real HTTP request with a real sealed session cookie, refused or
 * answered by the routes an owner's browser actually reaches. It is the half
 * that would still have caught a handler reading `?org_id=` and passing it to
 * `withOrg`, which the two below it cannot see at all.
 *
 * Everything is real except the key that signs the access token; the note in
 * ../test/sealed-session.ts says why that swap is the only one and what it
 * leaves for a live replay to cover.
 *
 * Golden fixtures rather than the gate's own two probe orgs: they are already
 * seeded before this step in CI, they carry staff, and one of them is empty,
 * so "no rows" and "another org's rows" are distinguishable.
 */

/**
 * No `DATABASE_URL`, no gate. This throws rather than skipping, because a
 * blocking suite that exits 0 having run nothing is the failure this repo keeps
 * finding: 21 skipped tests read as green in every summary that matters. The
 * `packages/db` half already fails here, inside `connect()`, and the two halves
 * of one gate cannot disagree about what a missing database means.
 *
 * Same shape as the secret scan, which refuses an empty `dist/client` rather
 * than passing it: nothing to check is a failure, not a pass.
 */
const url = process.env.DATABASE_URL
if (!url) {
  throw new Error(
    "DATABASE_URL is not set, so the cross-org gate has nothing to deny against. " +
      "It is blocking and cannot be skipped: start Postgres and point DATABASE_URL at it " +
      "(pnpm bootstrap, or a Neon branch), then rerun pnpm test:tenancy."
  )
}

const noted = (error: unknown) => console.error("waitUntil", error)
const ctx = {
  waitUntil: (promise: Promise<unknown>) => void promise.catch(noted),
} as ExecutionContext

/** Every golden org paired with the WorkOS ids a session for it would carry. */
const ORGS = GOLDEN_ORGS.map((org) => ({
  slug: org.slug,
  orgId: org.org.id as string,
  workosOrganizationId: org.org.workosOrganizationId as string,
  workosUserId: org.users[0]?.workosUserId as string,
  staffCodes: org.staff.map((member) => member.staffCode).sort(),
  staffIds: org.staff.map((member) => member.id as string),
}))

let realFetch: typeof fetch

beforeAll(() => {
  realFetch = globalThis.fetch
  globalThis.fetch = stubJwksFetch()
})

afterAll(() => {
  globalThis.fetch = realFetch
})

/** One request, signed as the person and organisation named. */
function as(
  who: { workosUserId: string; workosOrganizationId?: string },
  path: string
) {
  return cookieHeader({
    sub: who.workosUserId,
    org_id: who.workosOrganizationId,
    role: "owner",
  }).then((headers) =>
    worker.fetch(
      new Request(`http://api.invalid${path}`, { headers }),
      env(url as string),
      ctx
    )
  )
}

describe("the fixtures this suite denies against", () => {
  it("has more than one org, each with a person and an id", () => {
    // The whole matrix below is generated from this list. An empty or
    // single-entry list would make every cross-org case vacuous and every
    // assertion pass, which is the failure mode worth naming out loud.
    expect(ORGS.length).toBeGreaterThan(1)
    for (const org of ORGS) {
      expect(org.workosUserId, `${org.slug} has no owner`).toBeTruthy()
      expect(
        org.workosOrganizationId,
        `${org.slug} has no WorkOS organization`
      ).toBeTruthy()
    }
    // At least one org with staff, or "another org's staff did not appear"
    // would be true of an API that returned nothing at all.
    expect(ORGS.some((org) => org.staffIds.length > 0)).toBe(true)
  })
})

describe("a session reads its own org and only its own", () => {
  it.each(ORGS)("$slug", async (org) => {
    const response = await as(org, "/org")
    expect(response.status, `${org.slug} could not read itself`).toBe(200)
    const body = Org.parse(await response.json())
    expect(body.org_id).toBe(org.orgId)
    expect(body.slug).toBe(org.slug)
  })

  it.each(ORGS)("$slug staff, and nobody else's", async (org) => {
    const response = await as(org, "/staff")
    expect(response.status).toBe(200)
    const directory = StaffDirectory.parse(await response.json())

    expect(directory.staff.map((m) => m.staff_code).sort()).toEqual(
      org.staffCodes
    )
    for (const member of directory.staff) {
      expect(member.org_id, "a row from another org came back").toBe(org.orgId)
    }
    // And by id, not only by the org_id the row reports: a leak that also
    // rewrote org_id would pass the check above.
    const foreign = new Set(
      ORGS.filter((other) => other.orgId !== org.orgId).flatMap(
        (other) => other.staffIds
      )
    )
    for (const member of directory.staff) {
      expect(
        foreign.has(member.staff_id),
        `${member.staff_id} is not theirs`
      ).toBe(false)
    }
  })
})

describe("a session cannot name an org it does not belong to", () => {
  /** Every ordered pair of different orgs: this person, that organisation. */
  const crossed = ORGS.flatMap((person) =>
    ORGS.filter((org) => org.orgId !== person.orgId).map((org) => ({
      person,
      org,
      name: `${person.slug} claiming ${org.slug}`,
    }))
  )

  it.each(crossed)("$name", async ({ person, org }) => {
    for (const path of ["/org", "/staff"]) {
      const response = await worker.fetch(
        new Request(`http://api.invalid${path}`, {
          headers: await cookieHeader({
            sub: person.workosUserId,
            org_id: org.workosOrganizationId,
            role: "owner",
          }),
        }),
        env(url as string),
        ctx
      )
      // 403 and not 404: the resolver refuses a pair it cannot join, and it
      // gives the same answer for "no org selected" and "an org we do not
      // mirror" on purpose, so a caller cannot use it to learn which
      // organizations exist.
      expect(response.status, `${path} answered ${response.status}`).toBe(403)
      expect(ErrorEnvelope.parse(await response.json()).code).toBe(
        "org.unresolved"
      )
    }
  })

  it("refuses a session with no organisation at all", async () => {
    // Open item 21: a session minted before the org existed carries no
    // org_id claim. It has to be a refusal rather than a default.
    const [first] = ORGS
    const response = await as(
      { workosUserId: first?.workosUserId as string },
      "/org"
    )
    expect(response.status).toBe(403)
    expect(ErrorEnvelope.parse(await response.json()).code).toBe(
      "org.unresolved"
    )
  })

  it("refuses an organisation nothing mirrors", async () => {
    const [first] = ORGS
    const response = await as(
      {
        workosUserId: first?.workosUserId as string,
        workosOrganizationId: "org_that_is_not_in_our_database",
      },
      "/org"
    )
    expect(response.status).toBe(403)
  })
})

describe("the org is the session's, whatever the request says", () => {
  /**
   * The rule R3 states, driven at the only point it can actually be broken.
   *
   * `test/org.test.ts` sends the same spellings with no session and gets 401,
   * which proves the router refuses an anonymous request and nothing about
   * where an org id comes from. Here the session is valid, the request is
   * answered, and the answer has to be the session's org rather than the one
   * in the query string. A handler that read the query would pass every other
   * case in this file and fail only this one.
   */
  it.each(["org_id", "orgId", "organization_id", "organizationId", "org"])(
    "ignores ?%s",
    async (key) => {
      const [mine, theirs] = ORGS
      if (!(mine && theirs)) return
      for (const value of [theirs.orgId, theirs.workosOrganizationId]) {
        const response = await as(
          mine,
          `/org?${key}=${encodeURIComponent(value)}`
        )
        expect(response.status, `${key}=${value}`).toBe(200)
        const body = Org.parse(await response.json())
        expect(body.org_id, `${key}=${value} changed the org`).toBe(mine.orgId)
      }
    }
  )

  it("ignores a header naming another org", async () => {
    const [mine, theirs] = ORGS
    if (!(mine && theirs)) return
    const headers = await cookieHeader({
      sub: mine.workosUserId,
      org_id: mine.workosOrganizationId,
      role: "owner",
    })
    const response = await worker.fetch(
      new Request("http://api.invalid/staff", {
        headers: {
          ...headers,
          "x-org-id": theirs.orgId,
          "x-organization-id": theirs.workosOrganizationId,
        },
      }),
      env(url as string),
      ctx
    )
    expect(response.status).toBe(200)
    const directory = StaffDirectory.parse(await response.json())
    for (const member of directory.staff) {
      expect(member.org_id).toBe(mine.orgId)
    }
  })
})
