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
} from "@workspace/db"
import { afterAll, describe, expect, it, vi } from "vitest"
import { takeSnapshot } from "../src/brief.ts"
import { accessible } from "../src/publish.ts"
import { advance } from "../src/state.ts"
import { checkA11y, validateRevision } from "../src/validate.ts"
import { freshOrg, kit, newAssignment, SUFFIX } from "./fixture.ts"

// The brief names the registry host the sandbox module owns, and that module
// loads the container SDK, which only resolves under workerd.
vi.mock("../src/sandbox.ts", () => ({
  NPM_REGISTRY_HOST: "registry.npmjs.org",
}))

const url = process.env.DATABASE_URL
const live = describe.skipIf(!url)
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

const CLEAN = '{"pages":[{"path":"/","violations":[]}]}'
const page = (main: string) =>
  `<!doctype html><html lang="en"><head><title>BrightClean</title></head><body><main><h1>BrightClean</h1>${main}<a href="/">Home</a></main></body></html>`
const GOOD = page(
  "<p>$35 an hour</p><p>Weekdays 08:00 to 17:00</p><p>Call +15550142</p>"
)

/**
 * An org, briefed and built, waiting in `validating` with one revision in a
 * fake R2. `report` writes another revision and its report on the same build;
 * passing `org` builds again on an existing org.
 */
async function built(html: string, withhold: string[] = [], org?: string) {
  const orgId = org ?? (await freshOrg(kit))
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
  const report = async (served: string) => {
    const revisionId = crypto.randomUUID()
    const prefix = `sites/${orgId}/${revisionId}/`
    const body = new TextEncoder().encode(served)
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
          changes: [
            { path: "src/site-config.ts", reason: "Filled from facts" },
          ],
          screenshots: [],
          checks: [
            { check: "astro check", exit_code: 0, output_key: null },
            { check: "astro build", exit_code: 0, output_key: null },
            { check: "custom sections", exit_code: 0, output_key: null },
          ],
          risks: [],
          decisions_needed: [],
          reported_at: new Date().toISOString(),
        }),
      })
    })
    // Axe's run over the build and the browser pass after it, clean unless
    // a test hands the gates another.
    const axeKey = `${prefix}axe.json`
    const interactionKey = `${prefix}interaction.json`
    objects.set(axeKey, new TextEncoder().encode(CLEAN))
    objects.set(
      interactionKey,
      new TextEncoder().encode('{"pages":7,"findings":[]}')
    )
    type Run = { exit_code: number; key: string | null }
    const axe: (Run & { interaction?: Run }) | null = {
      exit_code: 0,
      key: axeKey,
      interaction: { exit_code: 0, key: interactionKey },
    }
    return {
      input: { report_id: reportId, revision_id: revisionId, axe },
      prefix,
    }
  }
  const { input, prefix } = await report(html)
  const state = async () =>
    kit.withOrg({ orgId }, async (db) => {
      const [row] = await db
        .select()
        .from(assignments)
        .where(eq(assignments.id, ids.assignmentId))
      return row?.state
    })
  return { orgId, ids, sites, objects, input, prefix, factIds, state, report }
}

live("the accessibility gate before the preview", () => {
  const DIRTY = JSON.stringify({
    pages: [
      {
        path: "/",
        violations: [
          {
            id: "color-contrast",
            impact: "serious",
            help: "Elements must meet minimum color contrast ratio thresholds",
            targets: ["main > h1"],
            summary: "Fix any of the following: contrast 2.1:1",
            html: "<h1>BrightClean</h1>",
          },
        ],
      },
    ],
  })

  /** The gates over a build whose axe left `json` and exited `exit_code`. */
  const gated = async (json: string, exit_code: number) => {
    const b = await built(GOOD)
    const key = `${b.prefix}axe-dirty.json`
    b.objects.set(key, new TextEncoder().encode(json))
    const verdict = await validateRevision(
      kit,
      b.sites,
      b.ids,
      { ...b.input, axe: { ...b.input.axe, exit_code, key } },
      SUFFIX
    )
    return { ...b, verdict }
  }
  const passed = (b: Awaited<ReturnType<typeof built>>) =>
    kit.withOrg({ orgId: b.orgId }, (db) => accessible(db, b.input.revision_id))

  it("passes with the other gates, records a11y in the report and lets the publish read it", async () => {
    const b = await gated(CLEAN, 0)
    expect(b.verdict.outcome).toBe("preview_ready")
    expect(await b.state()).toBe("preview_ready")
    expect(await passed(b)).toBe(true)
    expect(b.objects.has(`${b.prefix}gates/a11y.json`)).toBe(true)
  })

  it("sends a violation back through repairing before any preview, with the detail the lead needs", async () => {
    const b = await gated(DIRTY, 1)
    expect(b.verdict.outcome).toBe("repairing")
    if (b.verdict.outcome !== "repairing") throw new Error("unreachable")
    const [gate] = b.verdict.failed
    expect(gate?.offending_node).toBe("/ main > h1")
    for (const part of [
      "color-contrast",
      "serious",
      "on /",
      "main > h1",
      "contrast 2.1:1",
      "<h1>BrightClean</h1>",
    ])
      expect(gate?.message).toContain(part)
    expect(await b.state()).toBe("implementing")
    expect(await passed(b)).toBe(false)
  })

  it("fails closed when axe did not run or left nothing readable", async () => {
    const none = await built(GOOD)
    const verdict = await validateRevision(
      kit,
      none.sites,
      none.ids,
      { ...none.input, axe: null },
      SUFFIX
    )
    expect(verdict.outcome).toBe("repairing")
    expect(await none.state()).toBe("implementing")
    expect((await gated("not json", 1)).verdict.outcome).toBe("repairing")
  })
})

live("the interaction gate before the preview", () => {
  /** The gates over a build whose browser pass left `json` and exited `exit_code`, or did not run. */
  const gated = async (
    interaction: { json: string; exit_code: number } | null
  ) => {
    const b = await built(GOOD)
    const key = `${b.prefix}interaction-run.json`
    if (interaction)
      b.objects.set(key, new TextEncoder().encode(interaction.json))
    const { interaction: _, ...axe } = b.input.axe ?? {
      exit_code: 0,
      key: null,
    }
    const verdict = await validateRevision(
      kit,
      b.sites,
      b.ids,
      {
        ...b.input,
        axe: interaction
          ? { ...axe, interaction: { exit_code: interaction.exit_code, key } }
          : axe,
      },
      SUFFIX
    )
    return { ...b, verdict }
  }

  it("passes a clean run and writes the gate's evidence", async () => {
    const b = await gated({ json: '{"pages":7,"findings":[]}', exit_code: 0 })
    expect(b.verdict.outcome).toBe("preview_ready")
    expect(b.objects.has(`${b.prefix}gates/interaction.json`)).toBe(true)
  })

  it("sends a broken page back through repairing with what broke", async () => {
    const b = await gated({
      json: JSON.stringify({
        pages: 7,
        findings: [
          {
            check: "menu",
            path: "/contact/",
            width: 390,
            detail:
              "the header's links are hidden and no visible button opens them",
          },
        ],
      }),
      exit_code: 1,
    })
    expect(b.verdict.outcome).toBe("repairing")
    if (b.verdict.outcome !== "repairing") throw new Error("unreachable")
    expect(b.verdict.failed.map((g) => g.gate)).toEqual(["interaction"])
    expect(b.verdict.failed[0]?.message).toContain(
      "menu on /contact/ at 390 px"
    )
    expect(await b.state()).toBe("implementing")
  })

  it("fails closed when the browser pass did not run", async () => {
    const b = await gated(null)
    expect(b.verdict.outcome).toBe("repairing")
    if (b.verdict.outcome !== "repairing") throw new Error("unreachable")
    expect(b.verdict.failed[0]?.message).toBe(
      "the pages were not tried in a browser"
    )
  })
})

live("a quick edit's accessibility gate after the preview", () => {
  const enc = (s: string) => new TextEncoder().encode(s)
  const DIRTY =
    '{"pages":[{"path":"/","violations":[{"id":"color-contrast","impact":"serious","targets":["main > h1"]}]}]}'

  /** A build at `preview_ready` with no axe in its report, and axe's run over it. */
  const previewReady = async () => {
    const b = await built(GOOD)
    const verdict = await validateRevision(
      kit,
      b.sites,
      b.ids,
      { ...b.input, axe: "later" },
      SUFFIX
    )
    expect(verdict.outcome).toBe("preview_ready")
    const axe = (json: string, exit_code: number) => {
      const key = `${b.prefix}axe-late.json`
      b.objects.set(key, enc(json))
      return { exit_code, key }
    }
    const passed = () =>
      kit.withOrg({ orgId: b.orgId }, (db) =>
        accessible(db, b.input.revision_id)
      )
    const logged = () =>
      kit.withOrg({ orgId: b.orgId }, (db) =>
        db
          .select()
          .from(events)
          .where(
            sql`${events.assignmentId} = ${b.ids.assignmentId} and ${events.type} = 'revision.a11y_checked'`
          )
      )
    return { ...b, axe, passed, logged }
  }

  it("reaches preview_ready with no a11y row, and nothing publishes it until axe has run", async () => {
    const b = await previewReady()
    const [report] = await kit.withOrg({ orgId: b.orgId }, (db) =>
      db
        .select()
        .from(events)
        .where(
          sql`${events.assignmentId} = ${b.ids.assignmentId} and ${events.type} = 'assignment.validation_reported'`
        )
    )
    const gates = (report?.payload.gates ?? []) as { gate: string }[]
    expect(gates.map((g) => g.gate)).not.toContain("a11y")
    expect(await b.passed()).toBe(false)
  })

  it("logs a pass the review and the publish read, and keeps the preview", async () => {
    const b = await previewReady()
    const verdict = await checkA11y(
      kit,
      b.sites,
      b.ids,
      b.input.revision_id,
      b.axe(CLEAN, 0)
    )
    expect(verdict.outcome).toBe("preview_ready")
    expect(await b.state()).toBe("preview_ready")
    expect(await b.passed()).toBe(true)
    expect(b.objects.has(`${b.prefix}gates/a11y.json`)).toBe(true)
  })

  it("sends a preview with a violation back through repairing, and a retry answers the same", async () => {
    const b = await previewReady()
    const run = () =>
      checkA11y(kit, b.sites, b.ids, b.input.revision_id, b.axe(DIRTY, 1))
    const verdict = await run()
    expect(verdict.outcome).toBe("repairing")
    if (verdict.outcome !== "repairing") throw new Error("unreachable")
    expect(verdict.failed[0]?.offending_node).toBe("/ main > h1")
    expect(await b.state()).toBe("implementing")
    expect(await b.passed()).toBe(false)
    expect((await run()).outcome).toBe("repairing")
    expect(await b.logged()).toHaveLength(1)
  })

  it("fails closed and moves nothing when a newer edit took the sandbox before axe ran", async () => {
    const b = await previewReady()
    const verdict = await checkA11y(
      kit,
      b.sites,
      b.ids,
      b.input.revision_id,
      null
    )
    expect(verdict.outcome).toBe("stopped")
    expect(await b.state()).toBe("preview_ready")
    expect(await b.passed()).toBe(false)
  })

  it("moves nothing for a preview a newer edit superseded", async () => {
    const b = await previewReady()
    await advance(kit, b.ids, "cancelled")
    const verdict = await checkA11y(
      kit,
      b.sites,
      b.ids,
      b.input.revision_id,
      b.axe(DIRTY, 1)
    )
    expect(verdict.outcome).toBe("stopped")
    expect(await b.state()).toBe("cancelled")
  })
})

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

  it("numbers a revision only when it passes, so the owner's first version is v1", async () => {
    const b = await built(page("<p>$49 an hour</p>"))
    expect(
      (await validateRevision(kit, b.sites, b.ids, b.input, SUFFIX)).outcome
    ).toBe("repairing")
    await advance(kit, b.ids, "validating")
    const fixed = await b.report(GOOD)
    expect(
      (await validateRevision(kit, b.sites, b.ids, fixed.input, SUFFIX)).outcome
    ).toBe("preview_ready")
    // A site has one writer, so the first build ends before the next starts.
    await advance(kit, b.ids, "cancelled")
    const later = await built(GOOD, [], b.orgId)
    expect(
      (await validateRevision(kit, later.sites, later.ids, later.input, SUFFIX))
        .outcome
    ).toBe("preview_ready")
    const rows = await kit.withOrg({ orgId: b.orgId }, (db) =>
      db
        .select({
          id: siteRevisions.id,
          version: siteRevisions.version,
          summary: siteRevisions.summary,
        })
        .from(siteRevisions)
        .orderBy(siteRevisions.createdAt)
    )
    expect(rows.map((r) => [r.id, r.version])).toEqual([
      [b.input.revision_id, null],
      [fixed.input.revision_id, 1],
      [later.input.revision_id, 2],
    ])
    // The refused attempt stays on record with its summary, just unnumbered.
    expect(rows[0]?.summary).toBe("Filled from facts")
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
