import { useAuiState } from "@assistant-ui/react"
import { StatusLine } from "@workspace/ui/components/status-line"
import { resumingLine, stepText } from "@workspace/ui/lib/activity-copy"
import { stepOf } from "@workspace/ui/lib/tool-state"
import { useLiveWorkspace } from "@/lib/workspace"
import { IN_FLIGHT_MS, useResuming } from "./in-flight"

type Said = {
  role: string
  content: readonly {
    type: string
    toolName?: string
    args?: unknown
    argsText?: string
  }[]
  metadata: { custom: Record<string, unknown> }
}

/**
 * Whether the thread ends on a turn cut off with its continuation queued,
 * which has lasted no longer than a turn may run: undefined when it does not,
 * else the last step line the model wrote in it, or null when it wrote none.
 */
export function partialStep(
  messages: readonly Said[],
  now: number
): string | null | undefined {
  const last = messages.at(-1)
  if (last?.role !== "assistant" || last.metadata.custom.partial !== true) {
    return undefined
  }
  if (
    !(now - Date.parse(String(last.metadata.custom.createdAt)) < IN_FLIGHT_MS)
  )
    return undefined
  for (const part of [...last.content].reverse()) {
    const step =
      part.type === "tool-call" && part.toolName
        ? stepText(
            part.toolName,
            stepOf({ args: part.args, argsText: part.argsText })
          )
        : null
    if (step) return step
  }
  return null
}

/**
 * The working line under a message whose turn a reload cut off, until its
 * reply lands, and under a turn that hit its limit, with its last step, until
 * its continuation posts.
 */
export function StillWorking() {
  const resuming = useResuming()
  const live = useLiveWorkspace()
  const partial = useAuiState((s) => partialStep(s.thread.messages, Date.now()))
  if (!resuming && partial === undefined) return null
  return (
    <StatusLine
      delay={0}
      label={
        partial ??
        resumingLine({
          seed: "",
          assistant: live.workspace?.assistantName ?? null,
        })
      }
    />
  )
}
