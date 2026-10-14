/**
 * The Reme facade over flue and Pi (DR-3, ADR-031): the only package that
 * imports either. A `RuntimeSpec` in, a hook set out; every runtime event
 * teed into the log; guards that fail closed; a budget no transport can
 * bypass. Agent modules take everything from here.
 */

export type { BudgetEvent, BudgetGuard } from "./budget.ts"
export { createBudgetGuard } from "./budget.ts"
export { canonical, canonicalHash, canonicalHmac } from "./canonical.ts"
export type { DerivedContext } from "./derive.ts"
export { contextHash, deriveContext } from "./derive.ts"
export type { Edit } from "./edits.ts"
export { applyEdits } from "./edits.ts"
export { FacadeError } from "./errors.ts"
export * from "./flue.ts"
export type {
  MutationQueue,
  ToolPolicy,
  TurnGate,
  TurnGateOptions,
} from "./hooks.ts"
export {
  bashRefusal,
  boundResult,
  createMutationQueue,
  createTurnGate,
  guard,
  guardedTools,
  HOOK_TIMEOUT_MS,
  observer,
  pathRefusal,
  REPEATED_FAILURES,
  REPEATING_FAILURE,
  SANDBOX_UPDATING,
  TOOL_RESULT_MAX_CHARS,
} from "./hooks.ts"
export { OPENROUTER_IDS, openrouterModels } from "./models/index.ts"
export type { ToolInput } from "./schema.ts"
export { toolInput } from "./schema.ts"
export type { ModelChoice, ResolvedRuntime, UnsignedSpec } from "./spec.ts"
export {
  loggableSpec,
  MODELS,
  modelRouting,
  resolveRuntime,
  signSpec,
  TASK_CLASSES,
  verifySpec,
} from "./spec.ts"
export type { EventSink, Tee, TeeIds } from "./tee.ts"
export { createTee, redact } from "./tee.ts"
export type { ModelEnv, Transport } from "./transport.ts"
export {
  buildProviders,
  outboundUrl,
  REQUIRED,
  registerProviders,
  selectTransport,
  TRANSPORTS,
} from "./transport.ts"
