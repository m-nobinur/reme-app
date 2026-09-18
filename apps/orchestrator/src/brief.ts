import { FactSnapshot, type RuntimeSpec } from "@workspace/contracts"
import {
  assignments,
  eq,
  events,
  facts,
  type OrgScopedDb,
  sql,
  staff,
  supersedeFact,
  toFactRecord,
} from "@workspace/db"
import {
  loggableSpec,
  type ModelChoice,
  modelRouting,
  signSpec,
} from "@workspace/facade"
import { HIDDEN_FACTS_KEY } from "@workspace/gates"
import { NPM_REGISTRY_HOST } from "./sandbox.ts"
import { appendEvent, type Ids } from "./state.ts"

/** The owner's decision: model spend is capped at $1 per assignment. */
export const ASSIGNMENT_CAP_USD = 1

/** How long a spec is good for. A run past this needs a new session and spec. */
const SPEC_TTL_MS = 24 * 60 * 60 * 1000

/** What the Developer is handed at creation. Bodies here, ids on the Workflow (R8). */
export type Brief = {
  spec: RuntimeSpec
  snapshot: FactSnapshot
  goal: string
  acceptance_criteria: string[]
  /** R2 key of the source snapshot to restore, or null for the starter. */
  restore_key: string | null
  /** The restored site's map for the stable segment, or null for the starter's. */
  map: string | null
}

/**
 * The fact snapshot (architect ruling 4): the org's current facts, frozen as
 * one `facts.snapshot_taken` event the assignment names by id. `withhold`
 * exists for one test only, the run that must ask for `business.phone`; it
 * is read from the `assignment.created` event, never from a request.
 */
export async function takeSnapshot(
  db: OrgScopedDb,
  ids: Ids,
  withhold: readonly string[]
): Promise<FactSnapshot> {
  const rows = await db
    .select()
    .from(facts)
    .where(sql`${facts.validTo} is null`)
    .orderBy(facts.key)
  const snapshot = FactSnapshot.parse({
    snapshot_id: crypto.randomUUID(),
    org_id: ids.orgId,
    assignment_id: ids.assignmentId,
    taken_at: new Date().toISOString(),
    facts: rows
      .filter((row) => !withhold.includes(row.key))
      .map((row) => toFactRecord(row)),
  })
  await appendEvent(db, {
    orgId: ids.orgId,
    assignmentId: ids.assignmentId,
    staffId: null,
    type: "facts.snapshot_taken",
    payload: { ...snapshot, withheld: [...withhold] },
  })
  await db
    .update(assignments)
    .set({ factSnapshotId: snapshot.snapshot_id })
    .where(eq(assignments.id, ids.assignmentId))
  return snapshot
}

/** The keys withheld and the model chosen at creation, from the `assignment.created` row. */
export async function creationChoices(
  db: OrgScopedDb,
  ids: Ids
): Promise<{ withhold: string[]; model: ModelChoice }> {
  const [row] = await db
    .select({ payload: events.payload })
    .from(events)
    .where(
      sql`${events.assignmentId} = ${ids.assignmentId} and ${events.type} = 'assignment.created'`
    )
    .limit(1)
  const payload = row?.payload ?? {}
  const withhold = Array.isArray(payload.withhold)
    ? payload.withhold.filter((k): k is string => typeof k === "string")
    : []
  return { withhold, model: payload.model === "B" ? "B" : "A" }
}

/** The longest goal an assignment takes, in characters: it is in every turn's instructions. */
export const GOAL_MAX = 4000

/** What a fact value keeps across versions: its JSON type, and an object's keys. */
const shape = (value: unknown): string => {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (typeof value === "object") {
    return `object:${Object.keys(value).sort().join(",")}`
  }
  return typeof value
}

type WrittenFact = { key: string; fact_id: string; version: number }

export type FactsUpdate =
  | { outcome: "written"; replayed: boolean; facts: WrittenFact[] }
  | { outcome: "unknown_key"; key: string }
  | { outcome: "shape_changed"; key: string }

/**
 * The console standing in for the CoS (§15, architect ruling on the console):
 * a person restates facts the org already holds. A key with no current fact,
 * or a value of another shape, refuses the whole batch before anything is
 * written, so no one invents a claim category (R8). The writes and their one
 * `facts.updated` event share the caller's transaction; the idempotency key
 * rides in that event because no row of its own holds it.
 */
export async function updateFacts(
  db: OrgScopedDb,
  input: {
    orgId: string
    idempotencyKey: string
    changes: readonly { key: string; value: unknown }[]
  }
): Promise<FactsUpdate> {
  const [done] = await db
    .select({ payload: events.payload })
    .from(events)
    .where(
      sql`${events.type} = 'facts.updated' and ${events.payload}->>'idempotency_key' = ${input.idempotencyKey}`
    )
    .limit(1)
  if (done) {
    return {
      outcome: "written",
      replayed: true,
      facts: done.payload.facts as WrittenFact[],
    }
  }
  const current = await db
    .select()
    .from(facts)
    .where(sql`${facts.validTo} is null`)
  const planned = []
  for (const change of input.changes) {
    const row = current.find((r) => r.key === change.key)
    if (!row) return { outcome: "unknown_key", key: change.key }
    if (shape(row.value) !== shape(change.value)) {
      return { outcome: "shape_changed", key: change.key }
    }
    planned.push({ ...change, factType: row.factType })
  }
  const [chief] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(eq(staff.staffCode, "COS-001"))
  const written: WrittenFact[] = []
  for (const change of planned) {
    const result = await supersedeFact(db, {
      orgId: input.orgId,
      key: change.key,
      factType: change.factType,
      value: change.value,
      provenance: {
        source: "owner_stated",
        confidence: 1,
        verifiedByStaffId: chief?.id ?? null,
      },
    })
    written.push({
      key: change.key,
      fact_id: result.factId,
      version: result.version,
    })
  }
  await appendEvent(db, {
    orgId: input.orgId,
    assignmentId: null,
    staffId: chief?.id ?? null,
    type: "facts.updated",
    payload: { idempotency_key: input.idempotencyKey, facts: written },
  })
  return { outcome: "written", replayed: false, facts: written }
}

export type HiddenUpdate =
  | { outcome: "written"; replayed: boolean; hidden: string[] }
  | { outcome: "unknown_key"; key: string }

/**
 * ADR-033: what the owner has asked the site not to show, as one
 * `owner_stated` record holding the whole set of fact keys. The call carries
 * the set rather than a hide and a show verb, so showing a fact again is the
 * same call with a shorter list, and an unchanged set writes nothing: the set
 * is what makes a repeat safe, and the idempotency key rides on the event as
 * the record of the request. Every key must name a fact the org holds, the
 * refusal `updateFacts` gives an unknown key, so nobody hides what does not
 * exist. `updateFacts` cannot write this record, because the org holds no
 * fact under this key until the first call.
 */
export async function hideFacts(
  db: OrgScopedDb,
  input: {
    orgId: string
    idempotencyKey: string
    factKeys: readonly string[]
  }
): Promise<HiddenUpdate> {
  const current = await db
    .select()
    .from(facts)
    .where(sql`${facts.validTo} is null`)
  const wanted = [...new Set(input.factKeys)].sort()
  for (const key of wanted) {
    if (!current.some((row) => row.key === key)) {
      return { outcome: "unknown_key", key }
    }
  }
  const existing = current.find((row) => row.key === HIDDEN_FACTS_KEY)?.value
  const held = Array.isArray(existing)
    ? existing.filter((key): key is string => typeof key === "string")
    : []
  if (held.join("\n") === wanted.join("\n")) {
    return { outcome: "written", replayed: true, hidden: held }
  }
  const [chief] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(eq(staff.staffCode, "COS-001"))
  const written = await supersedeFact(db, {
    orgId: input.orgId,
    key: HIDDEN_FACTS_KEY,
    factType: "site_display",
    value: wanted,
    provenance: {
      source: "owner_stated",
      confidence: 1,
      verifiedByStaffId: chief?.id ?? null,
    },
  })
  await appendEvent(db, {
    orgId: input.orgId,
    assignmentId: null,
    staffId: chief?.id ?? null,
    type: "facts.updated",
    payload: {
      idempotency_key: input.idempotencyKey,
      facts: [
        {
          key: HIDDEN_FACTS_KEY,
          fact_id: written.factId,
          version: written.version,
        },
      ],
    },
  })
  return { outcome: "written", replayed: false, hidden: wanted }
}

/**
 * §6.1: the spec, resolved and signed here (architect ruling 3, open item
 * 48) and logged without its signature. The cap is the smaller of the
 * assignment's budget and the owner's per-assignment ceiling.
 */
export async function issueSpec(
  db: OrgScopedDb,
  env: {
    RUNTIME_SPEC_KEY: string
    REME_MODEL_DEFAULT?: string
    REME_MODEL_FALLBACK?: string
  },
  row: { id: string; orgId: string; staffId: string; budgetUsd: number },
  choice: ModelChoice
): Promise<RuntimeSpec> {
  const now = Date.now()
  const spec = signSpec(
    {
      spec_id: crypto.randomUUID(),
      org_id: row.orgId,
      staff_id: row.staffId,
      session_id: crypto.randomUUID(),
      profile: "builder",
      model_routing: modelRouting(env, choice),
      tool_manifest: [
        "site.edit",
        "site.checkpoint",
        "site.ask_chief",
        "site.report_complete",
      ],
      skill_refs: [],
      hook_set: [
        "session_start",
        "pre_model_call",
        "pre_tool_call",
        "post_tool_call",
        "information_gap",
        "checkpoint",
        "session_end",
      ],
      memory_namespaces: { read: [`org:${row.orgId}`], write: [] },
      context_policy: {
        max_input_tokens: 200_000,
        compaction_threshold_tokens: 150_000,
        include_fact_snapshot: true,
      },
      budget_snapshot: {
        model_usd_cap: Math.min(row.budgetUsd, ASSIGNMENT_CAP_USD),
        model_usd_spent: 0,
        tool_usd_cap: 0,
        tool_usd_spent: 0,
        period_ends_at: new Date(now + SPEC_TTL_MS).toISOString(),
      },
      sandbox_class: "standard-2",
      egress_allowlist: [NPM_REGISTRY_HOST],
      supervisor_ref: null,
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + SPEC_TTL_MS).toISOString(),
    },
    env.RUNTIME_SPEC_KEY
  )
  await appendEvent(db, {
    orgId: row.orgId,
    assignmentId: row.id,
    staffId: row.staffId,
    type: "runtime.spec_issued",
    payload: loggableSpec(spec),
  })
  return spec
}
