import {
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
  type Sandbox,
  type SandboxToolFactory,
} from "@flue/runtime"
import { FacadeError } from "./errors.ts"

/** §6.3: every Reme hook times out at 5 s. Guards fail closed, observers fail open. */
export const HOOK_TIMEOUT_MS = 5_000

function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms} ms`)),
      ms
    )
    fn().then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/**
 * A guard: a hook whose failure refuses the thing it guards. A throw, a
 * refusal or a timeout all end the same way, as a typed refusal; the
 * difference is in `detail.reason`.
 */
export async function guard<T>(
  name: string,
  fn: () => Promise<T>,
  timeoutMs: number = HOOK_TIMEOUT_MS
): Promise<T> {
  try {
    return await withTimeout(fn, timeoutMs)
  } catch (error) {
    if (error instanceof FacadeError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new FacadeError(
      "hook.refused",
      "permission",
      `${name} refused: ${message}`,
      { hook: name, reason: /timed out/.test(message) ? "timeout" : "error" }
    )
  }
}

/** An observer: a hook whose failure changes nothing. Its result is advisory. */
export async function observer<T>(
  name: string,
  fn: () => Promise<T>,
  timeoutMs: number = HOOK_TIMEOUT_MS
): Promise<T | undefined> {
  try {
    return await withTimeout(fn, timeoutMs)
  } catch (error) {
    console.warn(
      JSON.stringify({
        hook: name,
        failed_open: error instanceof Error ? error.message : String(error),
      })
    )
    return undefined
  }
}

/**
 * Where the model's file and shell tools may reach. `siteRoot` is the site
 * in the workspace; `readOnlyRoots` are paths a command may name but never
 * write, the image's toolchain for one.
 */
export type ToolPolicy = {
  siteRoot: string
  readOnlyRoots?: readonly string[]
}

const under = (path: string, root: string) =>
  path === root || path.startsWith(`${root.replace(/\/$/, "")}/`)

const hasParentSegment = (path: string) => path.split(/[/\s]/).includes("..")

/** `.agents/` holds the workspace skills; the model reads them through activation, never edits them. */
const touchesAgents = (path: string) =>
  /(^|[^A-Za-z0-9_.-])\.agents(?![A-Za-z0-9_-])/.test(path)

/**
 * The reason a shell command is refused, or null. Deliberately blunt: any
 * absolute path outside the site or a read-only root, any `..`, any mention
 * of `.agents/`, and `cd` to anywhere but inside the site. A false refusal
 * costs the model a retry; a false pass costs a tenant.
 */
export function bashRefusal(
  command: string,
  policy: ToolPolicy
): string | null {
  if (touchesAgents(command)) return "the command names .agents/"
  if (hasParentSegment(command)) return "the command contains a .. segment"
  const roots = [policy.siteRoot, ...(policy.readOnlyRoots ?? [])]
  const tokens = command.split(/\s+/)
  for (const raw of tokens) {
    const token = raw.replace(/^['"]|['"]$/g, "")
    if (!token.startsWith("/")) continue
    if (token === "/dev/null" || under(token, "/tmp")) continue
    if (!roots.some((root) => under(token, root))) {
      return `${token} is outside the site`
    }
  }
  const cd = command.match(/(?:^|[;&|]\s*)cd\s+(\S+)/)
  if (cd?.[1]?.startsWith("/") && !under(cd[1], policy.siteRoot)) {
    return `cd ${cd[1]} leaves the site`
  }
  return null
}

/** The reason a file path is refused for writing, or null. */
export function pathRefusal(
  path: string,
  policy: ToolPolicy,
  resolve: (p: string) => string
): string | null {
  if (hasParentSegment(path)) return "the path contains a .. segment"
  const absolute = resolve(path)
  if (touchesAgents(absolute)) return "the path is under .agents/"
  if (!under(absolute, policy.siteRoot))
    return `${absolute} is outside the site`
  return null
}

type ToolLike = {
  name: string
  execute: (...args: never[]) => Promise<unknown>
}

/** Wrap a tool's `execute` behind a fail-closed guard over its arguments. */
function guarded<T extends ToolLike>(
  tool: T,
  check: (params: Record<string, unknown>) => string | null
): T {
  const original = tool.execute as (...args: unknown[]) => Promise<unknown>
  const execute = async (id: string, params: unknown, ...rest: unknown[]) => {
    await guard("pre_tool_call", async () => {
      const refusal = check((params ?? {}) as Record<string, unknown>)
      if (refusal) {
        throw new FacadeError(
          "tool.refused",
          "permission",
          `${tool.name} refused: ${refusal}`,
          { tool: tool.name, reason: refusal }
        )
      }
    })
    return original(id, params, ...rest)
  }
  return { ...tool, execute: execute as T["execute"] }
}

/**
 * Flue's six tools with `bash`, `write` and `edit` behind the
 * `pre_tool_call` guard (§6.3). Passed as a sandbox factory's `tools`, so the
 * unguarded originals never reach the model.
 */
export function guardedTools(policy: ToolPolicy): SandboxToolFactory {
  return (sandbox: Sandbox) => {
    const path = (params: Record<string, unknown>) =>
      pathRefusal(String(params.path ?? ""), policy, (p) =>
        sandbox.resolvePath(p)
      )
    return [
      createReadTool(sandbox),
      guarded(createWriteTool(sandbox), path),
      guarded(createEditTool(sandbox), path),
      guarded(createBashTool(sandbox), (params) =>
        bashRefusal(String(params.command ?? ""), policy)
      ),
      createGrepTool(sandbox),
      createGlobTool(sandbox),
    ]
  }
}
