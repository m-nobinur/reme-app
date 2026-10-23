import { StatusLine } from "@workspace/ui/components/status-line"
import { resumingLine } from "@workspace/ui/lib/activity-copy"
import { useLiveWorkspace } from "@/lib/workspace"
import { useResuming } from "./in-flight"

/** The working line under a message whose turn a reload cut off, until its reply lands. */
export function StillWorking() {
  const resuming = useResuming()
  const live = useLiveWorkspace()
  if (!resuming) return null
  return (
    <StatusLine
      delay={0}
      kind="still"
      label={resumingLine({
        orgId: "",
        assistant: live.workspace?.assistantName ?? null,
      })}
    />
  )
}
