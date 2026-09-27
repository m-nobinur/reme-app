import { createHash } from "node:crypto"
import { CompletionReport, InformationAnswer } from "@workspace/contracts"
import {
  appendEvent,
  assignments,
  eq,
  events,
  orgs,
  siteRevisions,
  sql,
  supersedeFact,
  type Tenancy,
  tenancy,
} from "@workspace/db"
import { afterAll, describe, expect, it, vi } from "vitest"
import { takeSnapshot } from "../src/brief.ts"
import { advance } from "../src/state.ts"
import { validateRevision } from "../src/validate.ts"
import { freshOrg, newAssignment } from "./fixture.ts"

// The brief names the registry host the sandbox module owns, and that module
// loads the container SDK, which only resolves under workerd.
vi.mock("../src/sandbox.ts", () => ({
  NPM_REGISTRY_HOST: "registry.npmjs.org",
}))

const url = process.env.DATABASE_URL
const live = describe.skipIf(!url)
const kit: Tenancy = tenancy(url ?? "postgres://unused")
afterAll(() => kit.close())

const FACTS = [
  ["business.name", "identity", { name: "BrightClean" }],
  ["business.phone", "contact", { e164: "+15550142" }],
  ["business.email", "contact", { address: "hello@brightclean.invalid" }],
  ["hours.weekday", "hours", { open: "08:00", close: "17:00" }],
  [
    "pricing.standard_clean_hourly",
    "pricing",
    { currency: "USD", amount_minor: 3500 },
  ],
] as const

const SUFFIX = "-stg.remeai.co.uk"
const page = (main: string) =>
  `<!doctype html><html lang="en"><head><title>BrightClean</title></head><body><main><h1>BrightClean</h1>${main}<a href="/">Home</a></main></body></html>`
const GOOD = page(
  "<p>$35 an hour</p><p>Weekdays 08:00 to 17:00</p><p>Call +15550142</p>"
)

/** An org, briefed and built, waiting in `validating` with one revision in a fake R2. */
async function built(html: string, withhold: string[] = []) {
  const orgId = await freshOrg(kit)
  const ids = await newAssignment(kit, orgId)
  const objects = new Map<string, Uint8Array>()
  const sites = {
    get: async (key: string) => {
      const bytes = objects.get(key)
      return bytes ? { arrayBuffer: async () => bytes.slice().buffer } : null
    },
    put: async (key: string, value: string) => {
      objects.set(key, new TextEncoder().encode(value))
    },
  }
  const factIds: Record<string, string> = {}
  await kit.withOrg({ orgId }, async (db) => {
    for (const [key, factType, value] of FACTS) {
      const row = await supersedeFact(db, {
        orgId,
        key,
        factType,
        value,
        provenance: { source: "owner_stated", confidence: 1 },
      })
      factIds[key] = row.factId
    }
    await takeSnapshot(db, ids, withhold)
  })
  for (const to of [
    "briefing",
    "planning",
    "implementing",
    "validating",
  ] as const) {
    await advance(kit, ids, to)
  }
  const revisionId = crypto.randomUUID()
  const prefix = `sites/${orgId}/${revisionId}/`
  const body = new TextEncoder().encode(html)
  objects.set(`${prefix}dist/index.html`, body)
  objects.set(
    `${prefix}manifest.json`,
    new TextEncoder().encode(
      JSON.stringify({
        revision_id: revisionId,
        site_id: orgId,
        org_id: orgId,
        routes: [{ path: "/", file: "index.html" }],
        headers: {},
        files: {
          "index.html": createHash("sha256").update(body).digest("hex"),
        },
        built_at: new Date().toISOString(),
      })
    )
  )
  const reportId = crypto.randomUUID()
  await kit.withOrg({ orgId }, async (db) => {
    await db.insert(siteRevisions).values({
      id: revisionId,
      orgId,
      siteId: orgId,
      assignmentId: ids.assignmentId,
      version: 1,
      sourceKey: `${prefix}source.tar.zst`,
      artifactPrefix: `${prefix}dist/`,
      manifestKey: `${prefix}manifest.json`,
    })
    await appendEvent(db, {
      orgId,
      assignmentId: ids.assignmentId,
      staffId: null,
      type: "assignment.completion_reported",
      payload: CompletionReport.parse({
        report_id: reportId,
        org_id: orgId,
        assignment_id: ids.assignmentId,
        session_id: crypto.randomUUID(),
        revision_id: revisionId,
        summary: "Built the site",
        changes: [{ path: "src/site-config.ts", reason: "Filled from facts" }],
        screenshots: [],
        checks: [
          { check: "astro check", exit_code: 0, output_key: null },
          { check: "astro build", exit_code: 0, output_key: null },
        ],
        risks: [],
        decisions_needed: [],
        reported_at: new Date().toISOString(),
      }),
    })
  })
  const input = { report_id: reportId, revision_id: revisionId }
  const state = async () =>
    kit.withOrg({ orgId }, async (db) => {
      const [row] = await db
        .select()
        .from(assignments)
        .where(eq(assignments.id, ids.assignmentId))
      return row?.state
    })
  return { orgId, ids, sites, objects, input, prefix, factIds, state }
}

live("the gates step", () => {
  it("moves a site whose every claim traces to a fact to preview_ready, with its report and evidence", async () => {
    const b = await built(GOOD)
    const verdict = await validateRevision(kit, b.sites, b.ids, b.input, SUFFIX)
    expect(verdict.outcome).toBe("preview_ready")
    expect(await b.state()).toBe("preview_ready")
    expect(b.objects.has(`${b.prefix}gates/content.json`)).toBe(true)
    const [revision] = await kit.withOrg({ orgId: b.orgId }, (db) =>
      db
        .select()
        .from(siteRevisions)
        .where(eq(siteRevisions.id, b.input.revision_id))
    )
    expect(revision?.status).toBe("preview")
    const reports = await kit.withOrg({ orgId: b.orgId }, (db) =>
      db
        .select()
        .from(events)
        .where(
          sql`${events.assignmentId} = ${b.ids.assignmentId} and ${events.type} = 'assignment.validation_reported'`
        )
    )
    expect(reports).toHaveLength(1)
    expect(
      ((reports[0]?.payload.gates ?? []) as { passed: boolean }[]).every(
        (g) => g.passed
      )
    ).toBe(true)
    // A retried step answers with what it decided instead of failing.
    expect(
      (await validateRevision(kit, b.sites, b.ids, b.input, SUFFIX)).outcome
    ).toBe("preview_ready")
  })

  it("does not read the site's own host as a phone number, and throws without a host suffix", async () => {
    // The head `astro build --site` writes; the slug carries a date.
    const dated = async () => {
      const slug = `dated-20260925-${crypto.randomUUID().slice(0, 8)}`
      const b = await built(
        GOOD.replace(
          "</title>",
          `</title><meta property="og:url" content="https://${slug}${SUFFIX}/">`
        )
      )
      await kit.withOrg({ orgId: b.orgId }, (db) =>
        db.update(orgs).set({ slug }).where(eq(orgs.id, b.orgId))
      )
      return b
    }
    const b = await dated()
    await expect(
      validateRevision(kit, b.sites, b.ids, b.input, "")
    ).rejects.toThrow("not a host suffix")
    expect(
      (await validateRevision(kit, b.sites, b.ids, b.input, SUFFIX)).outcome
    ).toBe("preview_ready")
  })

  it("writes the Developer's summary on the revision whether the gates pass or fail", async () => {
    const summary = async (b: Awaited<ReturnType<typeof built>>) => {
      const [revision] = await kit.withOrg({ orgId: b.orgId }, (db) =>
        db
          .select({ summary: siteRevisions.summary })
          .from(siteRevisions)
          .where(eq(siteRevisions.id, b.input.revision_id))
      )
      return revision?.summary
    }
    const passed = await built(GOOD)
    await validateRevision(kit, passed.sites, passed.ids, passed.input, SUFFIX)
    expect(await summary(passed)).toBe("Filled from facts")
    const failed = await built(page("<p>$49 an hour</p>"))
    await validateRevision(kit, failed.sites, failed.ids, failed.input, SUFFIX)
    expect(await summary(failed)).toBe("Filled from facts")
  })

  it("sends a fabricated price back through repairing, naming the node", async () => {
    const b = await built(page("<p>$49 an hour</p>"))
    const verdict = await validateRevision(kit, b.sites, b.ids, b.input, SUFFIX)
    expect(verdict.outcome).toBe("repairing")
    expect(await b.state()).toBe("implementing")
    if (verdict.outcome !== "repairing") throw new Error("unreachable")
    expect(verdict.failed.map((g) => g.gate)).toEqual(["content"])
    expect(verdict.failed[0]?.offending_node).toContain("html>body>main>p")
  })

  it("ends a fourth failure in failed", async () => {
    const b = await built(page("<p>$49 an hour</p>"))
    for (let i = 0; i < 3; i++) {
      expect(
        (await validateRevision(kit, b.sites, b.ids, b.input, SUFFIX)).outcome
      ).toBe("repairing")
      await advance(kit, b.ids, "validating")
    }
    expect(
      (await validateRevision(kit, b.sites, b.ids, b.input, SUFFIX)).outcome
    ).toBe("failed")
    expect(await b.state()).toBe("failed")
  })

  it("counts a fact the Developer asked for and was answered", async () => {
    const b = await built(GOOD, ["business.phone"])
    await kit.withOrg({ orgId: b.orgId }, (db) =>
      appendEvent(db, {
        orgId: b.orgId,
        assignmentId: b.ids.assignmentId,
        staffId: null,
        type: "information.answered",
        payload: InformationAnswer.parse({
          answer_id: crypto.randomUUID(),
          org_id: b.orgId,
          assignment_id: b.ids.assignmentId,
          request_id: crypto.randomUUID(),
          fact_id: b.factIds["business.phone"],
          answered_at: new Date().toISOString(),
        }),
      })
    )
    expect(
      (await validateRevision(kit, b.sites, b.ids, b.input, SUFFIX)).outcome
    ).toBe("preview_ready")
  })
})
