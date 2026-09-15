import { Type } from "@earendil-works/pi-ai"
import {
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
  type FlueExecutionInterceptor,
  type Sandbox,
  type SandboxToolFactory,
} from "@flue/runtime"
import { applyEdits } from "./edits.ts"
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

/**
 * The most text one tool result may put in front of the model: about 4,700
 * tokens at the 3.4 characters a token measured on the starter, under a tenth
 * of the spec's context policy. Cut inside the tool, before flue logs the
 * result, so the log holds exactly what the model saw (§10.6).
 */
export const TOOL_RESULT_MAX_CHARS = 16_000

/** flue's glob stops at this many paths and says nothing. */
const FLUE_GLOB_LIMIT = 1_000

type ToolResult = {
  content: { type: string; text?: string }[]
  details?: unknown
  terminate?: boolean
}

/**
 * A result the model can trust to say when it is partial. Shell output keeps
 * its tail, where errors land; everything else keeps its head. Every cut
 * names where the rest is.
 */
export function boundResult<T extends ToolResult>(
  toolName: string,
  result: T
): T {
  const texts = result.content.filter((c) => c.type === "text")
  const joined = texts.map((c) => c.text ?? "").join("")
  const total = joined.length
  const max = TOOL_RESULT_MAX_CHARS
  let out: string | null = null
  if (total > max) {
    if (toolName === "bash") {
      out = `[Output cut to the last ${max} of ${total} characters. Rerun the command with its output sent to a file under /tmp, then read that file with offset and limit.]\n${joined.slice(-max)}`
    } else if (toolName === "read") {
      out = `${joined.slice(0, max)}\n[Output cut at ${max} of ${total} characters. Read the rest with offset and limit.]`
    } else if (toolName === "grep" || toolName === "glob") {
      out = `${joined.slice(0, max)}\n[Output cut at ${max} of ${total} characters. Narrow the pattern or the path.]`
    } else {
      out = `${joined.slice(0, max)}\n[Output cut at ${max} of ${total} characters.]`
    }
  } else if (
    toolName === "glob" &&
    joined.split("\n").filter(Boolean).length >= FLUE_GLOB_LIMIT
  ) {
    out = `${joined}\n[Showing the first ${FLUE_GLOB_LIMIT} matches; there may be more. Narrow the pattern or the path.]`
  }
  if (out === null) return result
  return {
    ...result,
    content: [
      ...result.content.filter((c) => c.type !== "text"),
      { type: "text", text: out },
    ],
  }
}

/** Tools that end the Developer's turn by waking the Workflow. */
const TERMINAL = new Set(["ask_chief", "report_complete"])
/** Tools that change nothing, so they may run after a turn has ended. */
const READS = new Set(["read", "grep", "glob"])
/** flue mounts `task` whether asked or not; no story has needed a subagent yet. */
const REFUSED = new Set(["task"])

export type TurnGate = {
  /** Install with flue's `instrument()`; it sees every tool call by name before it runs. */
  interceptor: FlueExecutionInterceptor
  /** Call at every delivery (`useAgentStart`): the next message is a new turn. */
  open: () => void
}

/**
 * One terminal call per turn and nothing that writes after it (architect
 * ruling, parallelism). The first `ask_chief` or `report_complete` closes the
 * turn before it awaits anything, so a second terminal call in the same batch
 * is refused even when the batch runs in parallel; a terminal call that throws
 * (a build that fails) reopens it so the model can fix what it reported.
 */
export function createTurnGate(): TurnGate {
  // ponytail: in memory, so an isolate restart mid-response forgets a closed
  // turn; move it to persistent state the first time a recording shows that.
  let closedBy: string | null = null
  const interceptor: FlueExecutionInterceptor = async (
    operation,
    _ctx,
    next
  ) => {
    if (operation.type !== "tool") return next()
    const name = operation.toolName
    if (REFUSED.has(name)) {
      throw new FacadeError(
        "tool.refused",
        "permission",
        `${name} is not available to this agent. Do the work with the tools you have.`,
        { tool: name }
      )
    }
    if (closedBy !== null && !READS.has(name)) {
      throw new FacadeError(
        "turn.over",
        "validation",
        `Your turn is over: ${closedBy} already ended it, so ${name} did not run. Wait for the next message.`,
        { tool: name, closed_by: closedBy }
      )
    }
    if (!TERMINAL.has(name)) return next()
    closedBy = name
    try {
      return await next()
    } catch (error) {
      closedBy = null
      throw error
    }
  }
  return {
    interceptor,
    open: () => {
      closedBy = null
    },
  }
}

type ToolLike = {
  name: string
  execute: (...args: never[]) => Promise<unknown>
}

/**
 * A flue tool behind the fail-closed `pre_tool_call` guard when it has a
 * check, bounded, and marked sequential when it changes the site: Pi runs a
 * whole batch in model order when any call in it is sequential, so no two
 * writes, and no write and a report, ever run at once.
 */
function wrap<T extends ToolLike>(
  tool: T,
  options: {
    check?: (params: Record<string, unknown>) => string | null
    sequential?: boolean
  } = {}
): T {
  const original = tool.execute as (...args: unknown[]) => Promise<unknown>
  const execute = async (id: string, params: unknown, ...rest: unknown[]) => {
    const { check } = options
    if (check) {
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
    }
    const result = await original(id, params, ...rest)
    return boundResult(tool.name, result as ToolResult)
  }
  return {
    ...tool,
    execute: execute as T["execute"],
    ...(options.sequential ? { executionMode: "sequential" as const } : {}),
  }
}

type EditInput = { path: string; edits: { oldText: string; newText: string }[] }

/**
 * Pi's argument repairs, from its `edit.ts` at 8a7b0c0: edits sent as a JSON
 * string, a single edit object, or the legacy top-level oldText and newText.
 */
function prepareEditArguments(input: unknown): EditInput {
  if (!input || typeof input !== "object") return input as EditInput
  const args = { ...(input as Record<string, unknown>) }
  const single = (v: unknown) =>
    !!v &&
    typeof v === "object" &&
    typeof (v as Record<string, unknown>).oldText === "string" &&
    typeof (v as Record<string, unknown>).newText === "string"
  if (typeof args.edits === "string") {
    try {
      const parsed = JSON.parse(args.edits)
      if (Array.isArray(parsed)) args.edits = parsed
      else if (single(parsed)) args.edits = [parsed]
    } catch {
      // Left as it is; the schema names what is wrong.
    }
  } else if (single(args.edits)) {
    args.edits = [args.edits]
  }
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    const edits = Array.isArray(args.edits) ? [...args.edits] : []
    edits.push({ oldText: args.oldText, newText: args.newText })
    delete args.oldText
    delete args.newText
    args.edits = edits
  }
  return args as EditInput
}

/** The batch point edit on Pi's rules and in Pi's words (§8.2); `applyEdits` holds the matching. */
function createBatchEditTool(sandbox: Sandbox) {
  return {
    name: "edit",
    label: "Edit File",
    description:
      "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to edit" }),
      edits: Type.Array(
        Type.Object({
          oldText: Type.String({
            description:
              "Exact text of one unique region of the file as it is now",
          }),
          newText: Type.String({ description: "The text that replaces it" }),
        }),
        {
          description:
            "Every replacement for this file, each matched against the file before any is applied",
        }
      ),
    }),
    prepareArguments: prepareEditArguments,
    async execute(_toolCallId: string, params: EditInput) {
      const content = await sandbox.readFile(params.path)
      await sandbox.writeFile(
        params.path,
        applyEdits(content, params.edits, params.path)
      )
      return {
        content: [
          {
            type: "text" as const,
            text: `Successfully replaced ${params.edits.length} block(s) in ${params.path}.`,
          },
        ],
        details: { path: params.path, edits: params.edits.length },
      }
    },
  }
}

/** A git commit in the container (§6.3 `checkpoint`), so a later attempt or revision starts from here. */
function createCheckpointTool(sandbox: Sandbox, root: string, git: string) {
  return {
    name: "checkpoint",
    label: "Checkpoint",
    description:
      "Commit the current state of the site with a one-line summary. Call it after a coherent set of edits.",
    parameters: Type.Object({
      summary: Type.String({
        description: "One line saying what the edits did",
      }),
    }),
    async execute(_toolCallId: string, params: { summary: string }) {
      // Nothing the model writes can leave the quotes it is put in.
      const message = params.summary.replace(/["`$\\]/g, "").slice(0, 120)
      const r = await sandbox.exec(
        `cd ${root} && ${git} add -A && (${git} commit -qm "${message}" || true) && ${git} rev-parse --short HEAD`
      )
      const output = { commit: r.stdout.trim(), exit_code: r.exitCode }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        details: output,
      }
    },
  }
}

/** Which edit tool the Developer gets. Two until the measurement picks one; then one. */
export type EditArm = "batch" | "flue"

/**
 * The Developer's sandbox tools: flue's read, grep and glob; write and bash
 * behind the `pre_tool_call` guard; one `edit` behind the same path guard;
 * `checkpoint`. Every result is bounded, and every tool that changes the site
 * runs in model order. Passed as a sandbox factory's `tools`, so no
 * unguarded original reaches the model.
 */
export function guardedTools(
  policy: ToolPolicy,
  options: { edit: EditArm; git: string }
): SandboxToolFactory {
  return (sandbox: Sandbox) => {
    const path = (params: Record<string, unknown>) =>
      pathRefusal(String(params.path ?? ""), policy, (p) =>
        sandbox.resolvePath(p)
      )
    const edit =
      options.edit === "flue"
        ? createEditTool(sandbox)
        : createBatchEditTool(sandbox)
    return [
      wrap(createReadTool(sandbox)),
      wrap(createWriteTool(sandbox), { check: path, sequential: true }),
      wrap(edit as ToolLike, { check: path, sequential: true }),
      wrap(createBashTool(sandbox), {
        check: (params) => bashRefusal(String(params.command ?? ""), policy),
        sequential: true,
      }),
      wrap(createGrepTool(sandbox)),
      wrap(createGlobTool(sandbox)),
      wrap(createCheckpointTool(sandbox, policy.siteRoot, options.git), {
        sequential: true,
      }),
    ] as ReturnType<SandboxToolFactory>
  }
}
