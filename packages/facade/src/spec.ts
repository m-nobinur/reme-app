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
 */
export const MODELS = {
  A: "openrouter/deepseek/deepseek-v4.1-flash",
  B: "openrouter/z-ai/glm-5.3-flash",
  fallback: "openrouter/x-ai/grok-4.6",
} as const

export type ModelChoice = "A" | "B"

/** The task classes a spec routes (§29.1). `fallback` is taken on a provider error only. */
export const TASK_CLASSES = [
  "plan",
  "implement",
  "summarize",
  "repo_map",
  "compaction",
] as const

const MAX_OUTPUT_TOKENS = 16_384

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
  for (const task of TASK_CLASSES) {
    routing[task] = { model: primary, max_output_tokens: MAX_OUTPUT_TOKENS }
  }
  routing.fallback = { model: fallback, max_output_tokens: MAX_OUTPUT_TOKENS }
  return routing
}

/** Sign a spec with the control plane's key (HMAC-SHA256 over the canonical form of every other field). */
export async function signSpec(
  unsigned: UnsignedSpec,
  key: string
): Promise<RuntimeSpec> {
  const signature = await canonicalHmac(unsigned, key)
  return RuntimeSpec.parse({ ...unsigned, signature })
}

/**
 * §6.1: the runtime cannot amend its spec. Refuses, in this order, a spec
 * that is not the contract's shape, one whose signature does not match, and
 * one past `expires_at`. Nothing renders a hook before this returns.
 */
export async function verifySpec(
  input: unknown,
  key: string,
  now: Date = new Date()
): Promise<RuntimeSpec> {
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
  const expected = await canonicalHmac(unsigned, key)
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
  /** The model for the coding task classes. */
  model: string
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
export async function resolveRuntime(
  input: unknown,
  key: string,
  now: Date = new Date()
): Promise<ResolvedRuntime> {
  const spec = await verifySpec(input, key, now)
  const implement = spec.model_routing.implement
  if (!implement) {
    throw new FacadeError(
      "spec.no_route",
      "validation",
      "the routing table has no implement entry",
      { spec_id: spec.spec_id, routes: Object.keys(spec.model_routing) }
    )
  }
  return Object.freeze({
    spec,
    model: implement.model,
    fallback: spec.model_routing.fallback?.model ?? null,
    maxOutputTokens: implement.max_output_tokens,
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
