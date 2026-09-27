/**
 * The flue surface an agent module is allowed to touch (R2: agent modules
 * take hooks from the facade, never from `@flue/*`). Re-exported by name so
 * the door stays narrow and a new hook is a decision here, not a habit
 * elsewhere. The Cloudflare-only pieces live in `./cloudflare.ts`, because
 * importing them outside a Worker fails on `cloudflare:workers`.
 */
export {
  AgentInstanceExistsError,
  type AgentProps,
  type DispatchReceipt,
  defineTool,
  dispatch,
  type FlueHarness,
  type FlueObservation,
  init,
  instrument,
  observe,
  type Sandbox,
  type SandboxFactory,
  SubmissionConflictError,
  type ToolContext,
  type ToolDefinition,
  useAgentFinish,
  useAgentStart,
  useDelivery,
  useInitialData,
  useInstruction,
  useModel,
  usePersistentState,
  useResponseFinish,
  useSandbox,
  useTool,
} from "@flue/runtime"
