import { z } from "zod"
import { JsonObject, Timestamp, Ulid, Uuid, VersionedRef } from "./common.ts"

/** §6.3 runtime profiles. */
export const RuntimeProfile = z.enum([
  "lite",
  "builder",
  "browser",
  "integration",
])

/** §6.3 hooks. Guards fail closed, observers fail open, all time out at 5 s. */
export const HookName = z.enum([
  "session_start",
  "pre_model_call",
  "pre_tool_call",
  "post_tool_call",
  "information_gap",
  "checkpoint",
  "session_end",
])

/** §29.1: the router picks a model per task class, then a transport. */
export const ModelRoute = z.strictObject({
  model: z.string().min(1),
  max_output_tokens: z.int().positive(),
  /** Per-role reasoning effort and output cap; absent in specs signed before they existed. */
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  max_tokens: z.int().positive().optional(),
})

/** §10.3: the gateway intersects requested namespaces with this policy. */
export const MemoryNamespaces = z.strictObject({
  read: z.array(z.string().min(1)),
  write: z.array(z.string().min(1)),
})

/** §29.2: the budget is checked server-side, so no transport can bypass it. */
export const BudgetSnapshot = z.strictObject({
  model_usd_cap: z.number().nonnegative(),
  model_usd_spent: z.number().nonnegative(),
  tool_usd_cap: z.number().nonnegative(),
  tool_usd_spent: z.number().nonnegative(),
  period_ends_at: Timestamp,
})

/** §10.6: how the facade derives context, and when it compacts. */
export const ContextPolicy = z.strictObject({
  max_input_tokens: z.int().positive(),
  compaction_threshold_tokens: z.int().positive(),
  include_fact_snapshot: z.boolean(),
})

/**
 * `RuntimeSpec` (§6.1) is the contract between the control plane and the
 * harness. Resolved server-side, signed, injected at session start; the
 * runtime cannot amend it, and widening anything needs a new session with a
 * new spec. `org_id` is added to §6.1's field list because every tenant-scoped
 * payload carries one (R3).
 */
export const RuntimeSpec = z.strictObject({
  spec_id: Uuid,
  org_id: Uuid,
  staff_id: Uuid,
  session_id: Uuid,
  profile: RuntimeProfile,
  /** Keyed by task class, e.g. `triage`, `plan`, `implement`. */
  model_routing: z.record(z.string().min(1), ModelRoute),
  /** Capability keys, never credentials (R6). */
  tool_manifest: z.array(z.string().min(1)),
  skill_refs: z.array(VersionedRef),
  hook_set: z.array(HookName),
  memory_namespaces: MemoryNamespaces,
  context_policy: ContextPolicy,
  budget_snapshot: BudgetSnapshot,
  sandbox_class: z.enum(["virtual", "standard-2", "standard-3"]),
  egress_allowlist: z.array(z.string().min(1)),
  supervisor_ref: Uuid.nullable(),
  issued_at: Timestamp,
  expires_at: Timestamp,
  /** Detached signature over the rest of the spec. */
  signature: z.string().min(1),
})

/**
 * `CapabilityCall` (§19): the only way a runtime reaches the world (R6). The
 * gateway holds the credentials and re-checks policy server-side, whatever
 * the runtime's `pre_tool_call` hook decided.
 */
export const CapabilityCall = z.strictObject({
  call_id: Uuid,
  org_id: Uuid,
  staff_id: Uuid,
  session_id: Uuid,
  assignment_id: Uuid.nullable(),
  /** Dotted key, e.g. `calendar.create_event`. */
  capability_key: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
  args: JsonObject,
  /** Replaying a call returns the stored result rather than repeating it. */
  idempotency_key: Ulid,
  audit_id: Uuid,
  requested_at: Timestamp,
})

export type RuntimeProfile = z.infer<typeof RuntimeProfile>
export type HookName = z.infer<typeof HookName>
export type RuntimeSpec = z.infer<typeof RuntimeSpec>
export type CapabilityCall = z.infer<typeof CapabilityCall>
