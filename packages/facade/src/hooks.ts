import { Type } from "@earendil-works/pi-ai"
import {
  createBashTool,
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
  // Split on shell punctuation too: `cat</etc/passwd` and `--out=/etc/x`
  // name a path with no space before it.
  // shortcut: a string check, not a shell parser, so a path spelled without
  // a slash (printf escapes) still passes; the org's own container is the
  // tenant boundary. Parse the command if this ever guards more than that.
  for (const token of command.split(/[\s;&|<>()`='"]+/)) {
    // `$HOME/x`, `~/x`, `\/etc`, `{/etc/passwd,}`: the shell makes the path.
    if (/^[^/]*[$~\\{][^/]*\//.test(token)) {
      return `${token} builds a path the check cannot read`
    }
    if (!token.startsWith("/")) continue
    if (token === "/dev/null" || under(token, "/tmp")) continue
    if (!roots.some((root) => under(token, root))) {
      return `${token} is outside the site`
    }
  }
  // Every `cd` and `pushd`: a bare one, `-`, `~` or `$HOME` leaves with no
  // slash for the loop above to see.
  for (const [, verb, to] of command.matchAll(
    /(?:^|[;&|(]\s*)(cd|pushd)(?:\s+([^\s;&|)]+))?/g
  )) {
    const leaves =
      !to ||
      to === "-" ||
      /[$~\\{`]/.test(to) ||
      (to.startsWith("/") && !under(to, policy.siteRoot))
    if (leaves) return `${verb} ${to ?? ""} leaves the site`.trim()
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

/** A subagent's answer to the lead: a summary, never a file dump (Pi's example caps 50 KB). */
export const TASK_RESULT_MAX_CHARS = 4_000

/** The lead reads a child's summary; the edits themselves are on disk. */
function boundTask<T>(result: T): T {
  const r = result as Partial<ToolResult> | undefined
  if (!Array.isArray(r?.content)) return result
  const joined = r.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("")
  const max = TASK_RESULT_MAX_CHARS
  if (joined.length <= max) return result
  return {
    ...r,
    content: [
      ...r.content.filter((c) => c.type !== "text"),
      {
        type: "text",
        text: `${joined.slice(0, max)}\n[The task's answer was cut at ${max} of ${joined.length} characters. Its edits are on disk: read the files for the rest.]`,
      },
    ],
  } as T
}

/** Tools that end the Developer's turn by waking the Workflow. */
const TERMINAL = new Set(["ask_chief", "report_complete"])
/** Tools that change nothing, so they may run after a turn has ended. */
const READS = new Set(["read", "grep", "glob"])
/**
 * Tools only the lead may call. A subagent never ends the lead's turn, never
 * delegates (depth stays one) and never commits: `checkpoint` runs
 * `git add -A`, which would sweep in a sibling's half-done edits. flue mounts
 * `task` on every session and the sandbox tools on every child, and the
 * sandbox factory cannot tell a child from the lead, so they come off here.
 */
const LEAD_ONLY = new Set([...TERMINAL, "task", "checkpoint"])

export type TurnGate = {
  /** Install with flue's `instrument()`; it sees every tool call by name before it runs. */
  interceptor: FlueExecutionInterceptor
  /** Call at every delivery (`useAgentStart`): the next message is a new turn. */
  open: () => void
  /** Whether a running tool call is a subagent's: for checks that see the call's id but not its session. */
  fromChild: (toolCallId: string) => boolean
}

export type TurnGateOptions = {
  /** Runs once when the gate ends a turn on the model's behalf, with the reason the Workflow will see. */
  onInterrupt?: (reason: string) => void
  /**
   * A thrown tool error that is the platform's rather than the model's: the
   * reason to end the turn with at once, or null. The caller knows its
   * sandbox; the gate does not.
   */
  interruptNow?: (error: unknown) => string | null
  /**
   * Runs after a tool returns, before the model sees its result, and is
   * awaited: the caller's chance to act on what the tool just did. It must
   * not throw, or the gate counts a failure the tool did not have.
   */
  onToolDone?: (name: string) => void | Promise<void>
  /** Runs once per subagent the gate stopped because the lead's turn ended under it. */
  onCancel?: (taskId: string, reason: string) => void
  /**
   * The lead's model calls a delivery may make before the gate takes every
   * tool away but the reads and `report_complete`, so a turn that runs long
   * reports what it did instead of running on to the time or money stop.
   */
  turnCap?: number
  /** Runs once a delivery, when the lead reaches `turnCap`. */
  onCapped?: (turns: number) => void
}

/** Consecutive thrown tool errors with the same text before the gate ends the turn. */
export const REPEATED_FAILURES = 3

/** The reason a turn ends when the same failure keeps coming back. */
export const REPEATING_FAILURE = "tool.repeating_failure"

/** The reason a turn ends when the platform replaced the container under it. */
export const SANDBOX_UPDATING = "sandbox.updating"

/** What every tool but the reads and the report hears past the turn cap; one text, so a lead that keeps calling ends as a repeating failure. */
export const TURN_CAPPED =
  "This turn has used its model calls, so only read, grep, glob and report_complete run now. Call report_complete with what you built, and say in its summary what is left undone."

/** A thrown error's identity: its message, whitespace collapsed, cut short. */
const failureText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error))
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 200)

/** A result that ends its caller's turn: the lead's, or one subagent's. */
const terminating = (code: string, text: string) =>
  ({
    content: [{ type: "text", text }],
    details: { code },
    terminate: true,
    // The interceptor is generic over the operation's own result; a tool
    // result is what every tool operation resolves to.
  }) as never

/**
 * One terminal call per turn and nothing that writes after it (architect
 * ruling, parallelism). The first `ask_chief` or `report_complete` closes the
 * turn before it awaits anything, so a second terminal call in the same batch
 * is refused even when the batch runs in parallel; a terminal call that throws
 * (a build that fails) reopens it so the model can fix what it reported.
 *
 * Subagents run inside the lead's `task` calls and reach this same gate with
 * `ctx.taskId` set. A terminal call is refused while any `task` runs, so a
 * report never builds under a child's edit. Each session counts its own
 * repeated failures, so a child that loops ends itself and not the lead.
 * When the lead's turn ends under running children, each stops at its next
 * call and is reported once through `onCancel`.
 */
export function createTurnGate(options: TurnGateOptions = {}): TurnGate {
  // ponytail: in memory, so an isolate restart mid-response forgets a closed
  // turn; move it to persistent state the first time a recording shows that.
  let closedBy: string | null = null
  // The repeated-failure counter (architect ruling, open item 55): keyed on
  // the error's text and not the tool's name, because the incident that
  // asked for it alternated bash and report_complete. Only a thrown error
  // counts: a command that ran and exited non-zero is the model doing its
  // job. Any result that returns resets it, and so does every delivery.
  // One counter per session: "" is the lead, a task id is a child.
  const failures = new Map<string, { text: string; repeats: number }>()
  let tasksRunning = 0
  let leadTurns = 0
  // flue runs each streamed chunk of a call through the interceptor as the same operation.
  const leadTurnIds = new Set<string>()
  let refusedPastCap = 0
  const childCalls = new Set<string>()
  const cancelled = new Set<string>()
  const cancel = (taskId: string, reason: string) => {
    if (cancelled.has(taskId)) return
    cancelled.add(taskId)
    options.onCancel?.(taskId, reason)
  }
  const ended = (reason: string, text: string) => {
    closedBy = reason
    failures.clear()
    options.onInterrupt?.(reason)
    // A terminating result, the way ask_chief and report_complete end a
    // turn; a throw would go back to the model as one more tool error.
    return terminating(reason, text)
  }
  const interceptor: FlueExecutionInterceptor = async (
    operation,
    ctx,
    next
  ) => {
    if (
      operation.type === "model" &&
      !ctx.taskId &&
      !leadTurnIds.has(operation.turnId)
    ) {
      leadTurnIds.add(operation.turnId)
      leadTurns += 1
      if (leadTurns === options.turnCap) options.onCapped?.(leadTurns)
    }
    if (operation.type !== "tool") return next()
    const name = operation.toolName
    const child = ctx.taskId
    if (child && LEAD_ONLY.has(name)) {
      throw new FacadeError(
        "tool.refused",
        "permission",
        `${name} is the lead's, not a subagent's. Do your part with the file tools and end with a short summary.`,
        { tool: name, task_id: child }
      )
    }
    if (child && closedBy !== null) {
      cancel(child, closedBy)
      return terminating(
        "task.cancelled",
        `The lead's turn ended (${closedBy}), so your task stops here. Reply with one line saying what you finished and what you did not.`
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
    if (
      !child &&
      options.turnCap !== undefined &&
      leadTurns > options.turnCap &&
      !READS.has(name) &&
      name !== "report_complete"
    ) {
      // Counted apart from the failures, which a read in between resets.
      refusedPastCap += 1
      if (refusedPastCap >= REPEATED_FAILURES)
        return ended(
          REPEATING_FAILURE,
          `${TURN_CAPPED} ${refusedPastCap} calls were refused, so this turn is over; the work resumes with a fresh look. Stop here.`
        )
      throw new FacadeError("turn.capped", "validation", TURN_CAPPED, {
        tool: name,
        turns: leadTurns,
      })
    }
    if (TERMINAL.has(name) && tasksRunning > 0) {
      throw new FacadeError(
        "tasks.running",
        "validation",
        `${name} did not run: ${tasksRunning} task(s) are still running. Call it on its own once they return.`,
        { tool: name, tasks_running: tasksRunning }
      )
    }
    if (TERMINAL.has(name)) closedBy = name
    const lane = child ?? ""
    if (child) childCalls.add(operation.toolCallId)
    if (name === "task") tasksRunning += 1
    try {
      const result = await next()
      failures.delete(lane)
      await options.onToolDone?.(name)
      return name === "task" ? boundTask(result) : result
    } catch (error) {
      if (TERMINAL.has(name)) closedBy = null
      const now = options.interruptNow?.(error)
      if (now) {
        if (child) cancel(child, now)
        return ended(
          now,
          `The platform interrupted your environment (${now}). This turn is over; the work resumes shortly. Stop here.`
        )
      }
      const text = failureText(error)
      const seen = failures.get(lane)
      const repeats = seen?.text === text ? seen.repeats + 1 : 1
      failures.set(lane, { text, repeats })
      if (repeats >= REPEATED_FAILURES) {
        const said = `The same failure has come back ${repeats} times: "${text}".`
        if (child) {
          failures.delete(lane)
          return terminating(
            REPEATING_FAILURE,
            `${said} Your task stops here. Reply with one line saying what you finished and what failed.`
          )
        }
        return ended(
          REPEATING_FAILURE,
          `${said} This turn is over; the work resumes with a fresh look. Stop here.`
        )
      }
      throw error
    } finally {
      if (name === "task") tasksRunning -= 1
      childCalls.delete(operation.toolCallId)
    }
  }
  return {
    interceptor,
    open: () => {
      closedBy = null
      failures.clear()
      cancelled.clear()
      leadTurns = 0
      leadTurnIds.clear()
      refusedPastCap = 0
    },
    fromChild: (toolCallId) => childCalls.has(toolCallId),
  }
}

/** The build a subagent may not start: the lead runs one for the whole site. */
const CHILD_BUILD = /\bastro\s+build\b/

/** Runs `fn` after every earlier call with the same key has settled; other keys do not wait. */
export type MutationQueue = <T>(key: string, fn: () => Promise<T>) => Promise<T>

/**
 * Pi's `withFileMutationQueue` (pi-agent-core 0.87.1,
 * `harness/tools/file-mutation-queue.js`), keyed by the caller rather than
 * by the env object, which flue rewraps for every tool build.
 */
export function createMutationQueue(): MutationQueue {
  const tails = new Map<string, Promise<unknown>>()
  return async (key, fn) => {
    const run = (tails.get(key) ?? Promise.resolve()).then(fn)
    const tail = run.catch(() => undefined)
    tails.set(key, tail)
    try {
      return await run
    } finally {
      if (tails.get(key) === tail) tails.delete(key)
    }
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
    check?: (
      params: Record<string, unknown>,
      toolCallId: string
    ) => string | null
    sequential?: boolean
    /** Runs the tool inside it, for writes that must not interleave. */
    around?: (
      params: Record<string, unknown>,
      run: () => Promise<unknown>
    ) => Promise<unknown>
  } = {}
): T {
  const original = tool.execute as (...args: unknown[]) => Promise<unknown>
  const execute = async (id: string, params: unknown, ...rest: unknown[]) => {
    const { check, around } = options
    const args = (params ?? {}) as Record<string, unknown>
    if (check) {
      await guard("pre_tool_call", async () => {
        const refusal = check(args, id)
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
    const run = () => original(id, params, ...rest)
    const result = await (around ? around(args, run) : run())
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

/**
 * The batch point edit on Pi's rules and in Pi's words (§8.2); `applyEdits`
 * holds the matching. Chosen over flue's single edit on 2026-09-15: three
 * interleaved golden builds a side, no failed edit in either, median
 * uncached input 5,819 against 10,761, tool calls 9 against 17.
 */
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
      const next = applyEdits(content, params.edits, params.path)
      if (next !== content) await sandbox.writeFile(params.path, next)
      return {
        content: [
          {
            type: "text" as const,
            text:
              next === content
                ? `Already applied: every edit's newText is in ${params.path} and its oldText is gone. Nothing changed.`
                : `Successfully replaced ${params.edits.length} block(s) in ${params.path}.`,
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
      "Commit the current state of the site with a one-line summary. Call it after a coherent set of edits, and before a risky change, so a later turn or an interrupted one can start from here. Only the lead builder calls it; a subagent that needs one reports to the lead instead.",
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

/**
 * The Developer's sandbox tools: flue's read, grep and glob; write and bash
 * behind the `pre_tool_call` guard; one `edit` behind the same path guard;
 * `checkpoint`. Every result is bounded, and every tool that changes the site
 * runs in model order. Passed as a sandbox factory's `tools`, so no
 * unguarded original reaches the model.
 *
 * Model order holds inside one session only. Subagents share the sandbox and
 * run at once, so writes and edits also wait their turn per resolved path:
 * one file's edits serialise, different files run in parallel. flue builds
 * the tools afresh for every session, so the caller passes one `mutations`
 * queue per assignment. `fromChild` is the turn gate's, for the one bash
 * command a subagent may not run.
 */
export function guardedTools(
  policy: ToolPolicy,
  options: {
    git: string
    mutations?: MutationQueue
    fromChild?: (toolCallId: string) => boolean
  }
): SandboxToolFactory {
  const mutations = options.mutations ?? createMutationQueue()
  return (sandbox: Sandbox) => {
    const path = (params: Record<string, unknown>) =>
      pathRefusal(String(params.path ?? ""), policy, (p) =>
        sandbox.resolvePath(p)
      )
    // shortcut: keyed on resolvePath, not realpath, so a symlink and its
    // target are two keys; the site has none the model writes through.
    const onePerFile = (
      params: Record<string, unknown>,
      run: () => Promise<unknown>
    ) => mutations(sandbox.resolvePath(String(params.path ?? "")), run)
    const bash = (params: Record<string, unknown>, toolCallId: string) => {
      const command = String(params.command ?? "")
      if (options.fromChild?.(toolCallId) && CHILD_BUILD.test(command)) {
        return "a subagent never runs astro build; the lead builds once after every task returns"
      }
      return bashRefusal(command, policy)
    }
    return [
      wrap(createReadTool(sandbox)),
      wrap(createWriteTool(sandbox), {
        check: path,
        sequential: true,
        around: onePerFile,
      }),
      wrap(createBatchEditTool(sandbox), {
        check: path,
        sequential: true,
        around: onePerFile,
      }),
      wrap(createBashTool(sandbox), { check: bash, sequential: true }),
      wrap(createGrepTool(sandbox)),
      wrap(createGlobTool(sandbox)),
      wrap(createCheckpointTool(sandbox, policy.siteRoot, options.git), {
        sequential: true,
      }),
    ] as ReturnType<SandboxToolFactory>
  }
}
