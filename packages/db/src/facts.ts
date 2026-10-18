import { eq, sql } from "drizzle-orm"
import { facts } from "./schema.ts"
import type { OrgScopedDb } from "./tenancy.ts"

/**
 * The one way a fact changes (§10.2). A fact is never overwritten: the
 * current version closes, the new one opens at `version + 1`, and the old
 * row points at its successor, all in the caller's transaction. Every
 * writer routes through here so the versioning rule has one home; the
 * `facts_one_current_per_key` index catches a breach, it does not replace
 * this function (architect ruling, builder track N3).
 */
export async function supersedeFact(
  db: OrgScopedDb,
  input: {
    orgId: string
    key: string
    factType: string
    value: unknown
    provenance: {
      source: "owner_stated" | "document" | "integration" | "inferred"
      confidence: number
      verifiedByStaffId?: string | null
    }
  }
): Promise<{
  factId: string
  version: number
  supersededFactId: string | null
}> {
  // The row lock below cannot serialise two writers when there is no current
  // row yet, or when the one they both waited on has just closed: each then
  // opens the same version. Key 5: 2 to 4 are the conversation, org and domain locks.
  await db.execute(
    sql`select pg_advisory_xact_lock(5, hashtext(${`${input.orgId}:${input.key}`}::text))`
  )
  const now = new Date()
  const [current] = await db
    .select({ id: facts.id, version: facts.version })
    .from(facts)
    .where(sql`${facts.key} = ${input.key} and ${facts.validTo} is null`)
    .for("update")
  const version = (current?.version ?? 0) + 1
  const verified = input.provenance.verifiedByStaffId ?? null
  if (current) {
    await db
      .update(facts)
      .set({ validTo: now, updatedAt: now })
      .where(eq(facts.id, current.id))
  }
  const [row] = await db
    .insert(facts)
    .values({
      orgId: input.orgId,
      key: input.key,
      factType: input.factType,
      value: input.value,
      version,
      provenanceSource: input.provenance.source,
      provenanceConfidence: input.provenance.confidence,
      verifiedByStaffId: verified,
      verifiedAt: verified ? now : null,
      validFrom: now,
    })
    .returning({ id: facts.id })
  if (!row) throw new Error("fact insert returned no row")
  if (current) {
    await db
      .update(facts)
      .set({ supersededByFactId: row.id })
      .where(eq(facts.id, current.id))
  }
  return {
    factId: row.id,
    version,
    supersededFactId: current?.id ?? null,
  }
}

/** The org's current facts, one row per key, in key order. */
export function currentFacts(db: OrgScopedDb) {
  return db
    .select()
    .from(facts)
    .where(sql`${facts.validTo} is null`)
    .orderBy(facts.key)
}
