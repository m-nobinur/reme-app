import type { FlueExecutionInterceptor } from "@flue/runtime"

/**
 * One cache write for a fan-out instead of one per child (index, caching
 * rules). Children that share tools, instructions and effort share a prompt
 * prefix; started together on a cold cache, each pays the write. So the
 * first child's first model call goes alone and its siblings' first calls
 * wait until its response begins, which is when Anthropic makes the entry
 * readable, or until it ends, whichever comes first. Later calls never wait.
 *
 * shortcut: one leader per fan-out, whatever the child's agent, so a child
 * on another model (the copy writer) may wait on a page builder's first
 * token for nothing; key the leader by agent once flue puts it on the
 * model operation's context.
 */
export type PrefixWarmer = {
  interceptor: FlueExecutionInterceptor
  /** Fed every observation: the leader's first streamed event releases the rest. */
  observe: (observation: { type?: string; taskId?: string }) => void
  /** A new delivery is a new fan-out. */
  reset: () => void
}

/** Events that mean the response has begun. */
const STREAMING = new Set([
  "message_start",
  "text_delta",
  "thinking_start",
  "thinking_delta",
  "toolcall_delta",
])

export function createPrefixWarmer(): PrefixWarmer {
  let leader: string | null = null
  let ready: Promise<void> = Promise.resolve()
  let release: () => void = () => undefined
  const seen = new Set<string>()
  const reset = () => {
    release()
    leader = null
    seen.clear()
  }
  const interceptor: FlueExecutionInterceptor = async (
    operation,
    ctx,
    next
  ) => {
    const child = ctx.taskId
    if (operation.type !== "model" || !child || seen.has(child)) return next()
    seen.add(child)
    if (leader !== null) {
      await ready
      return next()
    }
    leader = child
    ready = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      return await next()
    } finally {
      release()
    }
  }
  return {
    interceptor,
    observe: (o) => {
      if (o.taskId && o.taskId === leader && o.type && STREAMING.has(o.type))
        release()
    },
    reset,
  }
}
