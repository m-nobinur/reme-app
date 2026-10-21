import { PRIVATE_FACT_KEYS } from "@workspace/contracts"
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
export async function supersedeFact(db: OrgScopedDb, input: FactInput) {
  // A Developer question can name any field, so no business writer may reach
  // the owner's memory by key.
  if (PRIVATE_FACT_KEYS.includes(input.key)) {
    throw new Error(`fact.private_key: ${input.key} is not a business fact`)
  }
  return writeVersion(db, input)
}

/** The same write for the owner's memory (`PRIVATE_FACT_KEYS`), which only the memory module calls. */
export async function supersedePrivateFact(db: OrgScopedDb, input: FactInput) {
  if (!PRIVATE_FACT_KEYS.includes(input.key)) {
    throw new Error(`fact.not_private_key: ${input.key} is a business fact`)
  }
  return writeVersion(db, input)
}

type FactInput = {
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

async function writeVersion(
  db: OrgScopedDb,
  input: FactInput
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

/**
 * The org's current business facts, one row per key, in key order. The
 * Chief of Staff's memory of the owner (`PRIVATE_FACT_KEYS`) is left out
 * here, so no snapshot, tool or page built from this reads it by accident;
 * `currentFact` reads one on purpose.
 */
export function currentFacts(db: OrgScopedDb) {
  return db
    .select()
    .from(facts)
    .where(
      sql`${facts.validTo} is null and ${facts.key} not in (${sql.join(
        PRIVATE_FACT_KEYS.map((key) => sql`${key}`),
        sql`, `
      )})`
    )
    .orderBy(facts.key)
}

/** The current row of one key, or undefined. */
export async function currentFact(db: OrgScopedDb, key: string) {
  const [row] = await db
    .select()
    .from(facts)
    .where(sql`${facts.key} = ${key} and ${facts.validTo} is null`)
  return row
}

/** One key's versions, newest first. */
export function factVersions(db: OrgScopedDb, key: string, limit: number) {
  return db
    .select()
    .from(facts)
    .where(eq(facts.key, key))
    .orderBy(sql`${facts.version} desc`)
    .limit(limit)
}
