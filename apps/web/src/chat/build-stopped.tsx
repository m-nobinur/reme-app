import { stoppedOf } from "@/lib/stopped"
import { useLiveWorkspace } from "@/lib/workspace"

/** A failed build, said in the chat where it was asked for, until something newer happens. */
export function BuildStopped() {
  const { workspace } = useLiveWorkspace()
  const lines = workspace ? stoppedOf(workspace) : null
  return lines ? (
    <p className="my-3 text-muted-foreground text-sm" role="status">
      {lines.join(" ")}
    </p>
  ) : null
}
