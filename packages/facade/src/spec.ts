import { RuntimeSpec } from "@workspace/contracts"
import { canonicalHmac, timingSafeEqual } from "./canonical.ts"
import { FacadeError } from "./errors.ts"

/** A spec before it is signed: every field but the signature. */
export type UnsignedSpec = Omit<RuntimeSpec, "signature">

type ModelRoute = RuntimeSpec["model_routing"][string]

/**
 * The two selectable coding defaults and the one fallback (plan, decided
 * 2026-09-14). `REME_MODEL_DEFAULT` overrides A; `REME_MODEL_FALLBACK`
 * overrides the fallback. B is the other default and `--model B` picks it.
 * A is Claude Sonnet 5.5 from 2026-10-01, the owner's call.
 */
export const MODELS = {
  A: "openrouter/anthropic/claude-sonnet-5.5",
  B: "openrouter/z-ai/glm-5.3-flash",
  fallback: "openrouter/x-ai/grok-4.6",
  haiku: "openrouter/anthropic/claude-haiku-5.5",
} as const

export type ModelChoice = "A" | "B"

/** What a role asks of its model. Effort rides OpenRouter's `reasoning.effort`; the signed spec carries model and cap only. */
export type Effort = "low" | "medium" | "high"

/**
 * The builder's roles, one routing entry each (index runtime table, verified
 * 2026-10-14). A role keeps one effort for good: changing it mid-run would
 * invalidate the cached prefix. `sonnet` roles follow the primary model
 * (`REME_MODEL_DEFAULT`, `--model B`); `haiku` roles are fixed.
 */
export const ROLES = {
  // Kept at high (A/B 2026-10-16, 3 businesses): medium took 19 s and $0.03 a
  // plan against 38 s and $0.05, but 3 of its 9 plans failed the first
  // attempt, all for the business with a free-text direction note, by naming a
  // direction that is not in the library. High passed 3 of 3 (one per business).
  plan: { model: "sonnet", effort: "high", maxTokens: 32_000 },
  build: { model: "sonnet", effort: "medium", maxTokens: 32_000 },
  page: { model: "sonnet", effort: "medium", maxTokens: 16_000 },
  copy: { model: "haiku", effort: "low", maxTokens: 8_000 },
  critic: { model: "sonnet", effort: "medium", maxTokens: 4_000 },
  critic_recheck: { model: "haiku", effort: "low", maxTokens: 2_000 },
  quick_copy: { model: "haiku", effort: "low", maxTokens: 4_000 },
  quick_section: { model: "sonnet", effort: "low", maxTokens: 16_000 },
} as const satisfies Record<
  string,
  { model: "sonnet" | "haiku"; effort: Effort; maxTokens: number }
>

export type Role = keyof typeof ROLES

/** Haiku standing in for the primary model (development, staging) thinks at high on the primary's roles. */
export const effortOf = (role: Role, model: string): Effort =>
  ROLES[role].model === "sonnet" && model === MODELS.haiku
    ? "high"
    : ROLES[role].effort

const FALLBACK_MAX_OUTPUT_TOKENS = 16_384

/**
 * §29.1: one routing table in the spec, not in code. The resolver reads its
 * defaults from the environment; the facade reads the table and nothing else.
 */
export function modelRouting(
  env: { REME_MODEL_DEFAULT?: string; REME_MODEL_FALLBACK?: string },
  choice: ModelChoice = "A"
): Record<string, ModelRoute> {
  const primary =
    choice === "B" ? MODELS.B : env.REME_MODEL_DEFAULT?.trim() || MODELS.A
  const fallback = env.REME_MODEL_FALLBACK?.trim() || MODELS.fallback
  const routing: Record<string, ModelRoute> = {}
  for (const [role, r] of Object.entries(ROLES)) {
    routing[role] = {
      model: r.model === "haiku" ? MODELS.haiku : primary,
      max_output_tokens: r.maxTokens,
    }
  }
  routing.fallback = {
    model: fallback,
    max_output_tokens: FALLBACK_MAX_OUTPUT_TOKENS,
  }
  return routing
}

/**
 * A role as a verified spec routes it: model and cap from the signed table,
 * effort from `ROLES`. Throws on a role the spec does not route, because a
 * role that silently ran on another's model is a cost and cache bug.
 */
export function roleOf(
  spec: RuntimeSpec,
  role: Role
): { model: string; effort: Effort; maxTokens: number } {
  const route = spec.model_routing[role]
  if (!route) {
    throw new FacadeError(
      "spec.no_route",
      "validation",
      `the routing table has no ${role} entry`,
      { spec_id: spec.spec_id, routes: Object.keys(spec.model_routing) }
    )
  }
  return {
    model: route.model,
    effort: effortOf(role, route.model),
    maxTokens: route.max_output_tokens,
  }
}

/**
 * The largest cap any role gives each model, keyed by the id OpenRouter is
 * sent. The transport applies it to a call that sets none of its own and
 * whose role did not register its instructions (`withOutputCap`), which is
 * how a page builder gets 16k on the model whose lead gets 32k.
 */
export function outputCaps(
  ...tables: Record<string, ModelRoute>[]
): Record<string, number> {
  const caps: Record<string, number> = {}
  for (const route of tables.flatMap((t) => Object.values(t))) {
    const id = route.model.replace(/^openrouter\//, "")
    caps[id] = Math.max(caps[id] ?? 0, route.max_output_tokens)
  }
  return caps
}

/** Sign a spec with the control plane's key (HMAC-SHA256 over the canonical form of every other field). */
export function signSpec(unsigned: UnsignedSpec, key: string): RuntimeSpec {
  const signature = canonicalHmac(unsigned, key)
  return RuntimeSpec.parse({ ...unsigned, signature })
}

/**
 * §6.1: the runtime cannot amend its spec. Refuses, in this order, a spec
 * that is not the contract's shape, one whose signature does not match, and
 * one past `expires_at`. Nothing renders a hook before this returns.
 */
export function verifySpec(
  input: unknown,
  key: string,
  now: Date = new Date()
): RuntimeSpec {
  if (!key) {
    throw new FacadeError(
      "spec.key_missing",
      "resource",
      "RUNTIME_SPEC_KEY is not set, so no spec can be verified"
    )
  }
  const parsed = RuntimeSpec.safeParse(input)
  if (!parsed.success) {
    throw new FacadeError(
      "spec.malformed",
      "validation",
      "the runtime spec is not the contract's shape",
      { issues: parsed.error.issues.map((i) => i.path.join(".")) }
    )
  }
  const spec = parsed.data
  const { signature, ...unsigned } = spec
  const expected = canonicalHmac(unsigned, key)
  if (!timingSafeEqual(signature, expected)) {
    throw new FacadeError(
      "spec.signature_invalid",
      "security",
      "the runtime spec's signature does not match its content",
      { spec_id: spec.spec_id }
    )
  }
  if (Date.parse(spec.expires_at) <= now.getTime()) {
    throw new FacadeError(
      "spec.expired",
      "permission",
      "the runtime spec has expired; a new session needs a new spec",
      { spec_id: spec.spec_id, expires_at: spec.expires_at }
    )
  }
  return spec
}

/** What a verified spec resolves to: the hook set, read-only. */
export type ResolvedRuntime = Readonly<{
  spec: RuntimeSpec
  /** The model for the build role. */
  model: string
  /** The build role's effort: what `useModel` is given as `thinkingLevel`. */
  effort: Effort
  /** Taken on a provider error only, tagged on the event when it is. */
  fallback: string | null
  maxOutputTokens: number
  /** Capability keys the runtime may mount; a tool not named here does not exist. */
  tools: readonly string[]
  skills: RuntimeSpec["skill_refs"]
  hooks: RuntimeSpec["hook_set"]
  budget: RuntimeSpec["budget_snapshot"]
  context: RuntimeSpec["context_policy"]
  memory: RuntimeSpec["memory_namespaces"]
}>

/**
 * Turn a spec into the hook set the agent renders from. Verification first,
 * always; the result is frozen because §6.1 says a runtime cannot widen its
 * own tools, memory or budget, and a frozen object is how that reads in code.
 */
export function resolveRuntime(
  input: unknown,
  key: string,
  now: Date = new Date()
): ResolvedRuntime {
  const spec = verifySpec(input, key, now)
  const build = roleOf(spec, "build")
  return Object.freeze({
    spec,
    model: build.model,
    effort: build.effort,
    fallback: spec.model_routing.fallback?.model ?? null,
    maxOutputTokens: build.maxTokens,
    tools: Object.freeze([...spec.tool_manifest]),
    skills: spec.skill_refs,
    hooks: spec.hook_set,
    budget: spec.budget_snapshot,
    context: spec.context_policy,
    memory: spec.memory_namespaces,
  })
}

/** The spec as it is logged: `runtime.spec_issued` carries everything but the MAC (architect ruling 3). */
export function loggableSpec(spec: RuntimeSpec): UnsignedSpec {
  const { signature: _signature, ...rest } = spec
  return rest
}
