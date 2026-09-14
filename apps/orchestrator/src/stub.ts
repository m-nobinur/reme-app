import { CompletionReport, ValidationReport } from "@workspace/contracts"
import { eq, siteRevisions, sql, type Tenancy } from "@workspace/db"
import { advance, appendEvent, type Ids } from "./state.ts"

/**
 * The Developer until N3 replaces it: a step that writes one fixed
 * `CompletionReport` for the assignment and a revision row for it. No model,
 * no sandbox, no bytes in R2; the keys are the names the real one will use.
 * The report is parsed through the contract so the stub cannot drift from the
 * shape the console and the gates read.
 */
export function stubDeveloper(kit: Tenancy, ids: Ids) {
  return advance(kit, ids, "validating", {
    apply: async (db, row) => {
      const [latest] = await db
        .select({
          max: sql<number>`coalesce(max(${siteRevisions.version}), 0)::int`,
        })
        .from(siteRevisions)
        .where(eq(siteRevisions.siteId, row.orgId))
      const revisionId = crypto.randomUUID()
      const prefix = `sites/${row.orgId}/${revisionId}/`
      await db.insert(siteRevisions).values({
        id: revisionId,
        orgId: row.orgId,
        siteId: row.orgId,
        assignmentId: row.id,
        version: (latest?.max ?? 0) + 1,
        sourceKey: `${prefix}source.tar.zst`,
        artifactPrefix: `${prefix}dist/`,
        manifestKey: `${prefix}manifest.json`,
      })
      const report = CompletionReport.parse({
        report_id: crypto.randomUUID(),
        org_id: row.orgId,
        assignment_id: row.id,
        session_id: crypto.randomUUID(),
        revision_id: revisionId,
        summary: "Stub build: the starter restored unchanged.",
        changes: [
          { path: "src/site-config.ts", reason: "Stub: nothing edited yet" },
        ],
        screenshots: [],
        checks: [
          { check: "astro check", exit_code: 0, output_key: null },
          { check: "astro build", exit_code: 0, output_key: null },
        ],
        risks: ["This revision was written by the stub Developer, not a model"],
        decisions_needed: [],
        reported_at: new Date().toISOString(),
      })
      await appendEvent(db, {
        orgId: row.orgId,
        assignmentId: row.id,
        staffId: row.staffId,
        type: "assignment.completion_reported",
        payload: report,
        // Model output, or will be: nothing downstream may promote it.
        taint: ["inferred"],
      })
      return { revision_id: revisionId }
    },
  })
}

/**
 * The gates until P1 lands: every gate passes with no evidence. The report is
 * still contract-shaped and still appended, so the console shows the same
 * stream the real gates will write.
 */
export function stubGates(kit: Tenancy, ids: Ids) {
  return advance(kit, ids, "preview_ready", {
    apply: async (db, row) => {
      const [revision] = await db
        .select({ id: siteRevisions.id })
        .from(siteRevisions)
        .where(eq(siteRevisions.assignmentId, row.id))
        .orderBy(sql`${siteRevisions.version} desc`)
        .limit(1)
      if (!revision) throw new Error("the stub Developer wrote no revision")
      const report = ValidationReport.parse({
        report_id: crypto.randomUUID(),
        org_id: row.orgId,
        assignment_id: row.id,
        revision_id: revision.id,
        gates: ["build", "types", "links", "structured_data", "content"].map(
          (gate) => ({
            gate,
            passed: true,
            evidence_key: null,
            offending_node: null,
            message: null,
          })
        ),
        produced_at: new Date().toISOString(),
      })
      await appendEvent(db, {
        orgId: row.orgId,
        assignmentId: row.id,
        staffId: null,
        type: "assignment.validation_reported",
        payload: report,
      })
      await db
        .update(siteRevisions)
        .set({ status: "preview", updatedAt: new Date() })
        .where(eq(siteRevisions.id, revision.id))
      return { revision_id: revision.id }
    },
  })
}
