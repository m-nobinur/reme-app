import { AssignmentState, TERMINAL_STATES } from "@workspace/contracts"
import { getTableColumns, getTableName, is } from "drizzle-orm"
import { PgTable } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"
import { STAGING_CLIENT_ID } from "../../../apps/api/scripts/dev-owner.mjs"
import { PROBE_ORG_PREFIX } from "../../../qa/e2e/workos.ts"
import { clearOrgs, type Tx } from "../fixtures/seed.ts"
import {
  probeRefusal,
  STAGING,
  stagingRefusal,
} from "../scripts/clear-probes.ts"
import * as schema from "../src/schema.ts"

const ORG = "00000000-0000-4000-8000-000000000001"
const USER = "00000000-0000-4000-8000-000000000002"

describe("clearOrgs", () => {
  // The tenancy kit finds tenant tables by their org_id column; `orgs` is the
  // root it keys on. A new one missing here breaks the build, not a cleanup.
  const tenant = (Object.values(schema) as unknown[])
    .filter((value): value is PgTable => is(value, PgTable))
    .filter(
      (table) =>
        table === schema.orgs ||
        Object.values(getTableColumns(table)).some((c) => c.name === "org_id")
    )
    .map((table) => getTableName(table))

  it("deletes from every tenant table", async () => {
    const deleted: string[] = []
    const tx = {
      delete: (table: PgTable) => {
        deleted.push(getTableName(table))
        return { where: async () => undefined }
      },
    } as unknown as Tx
    await clearOrgs(tx, [ORG], [USER])
    expect(tenant.length).toBeGreaterThan(10)
    expect(tenant.filter((name) => !deleted.includes(name))).toEqual([])
    expect(deleted).toContain("users")
  })
})

describe("probeRefusal", () => {
  const probe = {
    name: `${PROBE_ORG_PREFIX}2026-09-28`,
    emails: ["qa-e2e-onboard-1234@example.net"],
    states: [] as string[],
  }

  it("takes a probe", () => {
    expect(probeRefusal(probe, "probe")).toBeNull()
  })

  it.each([
    ["a name without the prefix", { name: "Bright Clean" }],
    ["the prefix mid-name", { name: `x ${PROBE_ORG_PREFIX}` }],
    ["no members", { emails: [] }],
    ["another address", { emails: [...probe.emails, "owner@example.net"] }],
    ["the prefix at another domain", { emails: ["qa-e2e-1@example.com"] }],
    ["another prefix at the domain", { emails: ["owner+dev-1@example.net"] }],
  ])("refuses %s", (_why, change) => {
    expect(probeRefusal({ ...probe, ...change }, "probe")).not.toBeNull()
  })

  it("keeps only the assignment test in --org mode", () => {
    const leftover = { name: "Bright Clean", emails: ["a@b.c"], states: [] }
    expect(probeRefusal(leftover, "org")).toBeNull()
    expect(
      probeRefusal({ ...leftover, states: ["implementing"] }, "org")
    ).not.toBeNull()
  })

  it.each(
    AssignmentState.options.map((state) => [
      state,
      ["published", "failed", "cancelled"].includes(state),
    ])
  )("counts %s as finished: %s", (state, finished) => {
    for (const mode of ["probe", "org"] as const) {
      const refusal = probeRefusal(
        { ...probe, states: ["published", state] },
        mode
      )
      expect(refusal === null).toBe(finished)
    }
  })

  it("names only real states", () => {
    for (const state of TERMINAL_STATES)
      expect(AssignmentState.options).toContain(state)
  })
})

describe("stagingRefusal", () => {
  const staging = {
    neonProject: STAGING.neonProject,
    neonBranch: STAGING.neonBranch,
    hostSuffix: STAGING.hostSuffix,
    workosClientId: STAGING_CLIENT_ID,
    workosApiKey: "sk_test_x",
  }
  /** WorkOS's answer to staging's key: a code that cannot exist. */
  const stagingKey = (async () =>
    Response.json({ error: "invalid_grant" })) as unknown as typeof fetch
  it("lets staging through", async () => {
    expect(await stagingRefusal(staging, stagingKey)).toBeNull()
  })

  it.each([
    ["production's project", { neonProject: "weathered-rice-57505553" }],
    ["another branch", { neonBranch: "br-square-voice-b2n6yblp" }],
    ["production's host suffix", { hostSuffix: ".remeai.co.uk" }],
    ["another WorkOS client", { workosClientId: "client_01PRODUCTION" }],
  ])("refuses %s", async (_why, change) => {
    // The key itself is staging's, so only the changed field can refuse.
    expect(await stagingRefusal({ ...staging, ...change }, stagingKey)).toMatch(
      /not staging's/
    )
  })

  it("refuses a key that is not staging's", async () => {
    const other = (async () =>
      Response.json(
        { error: "invalid_client" },
        { status: 401 }
      )) as unknown as typeof fetch
    expect(await stagingRefusal(staging, other)).toMatch(/not staging's key/)
  })
})
