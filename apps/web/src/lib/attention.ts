import type { AttentionItem, Workspace } from "./api/types"

/** The workspace of a session with no organisation: nothing, and no tag. */
export const EMPTY_WORKSPACE: Workspace = {
  attention: [],
  live: null,
  building: false,
  open: false,
  builds: [],
  host: null,
  missingFacts: [],
  etag: null,
}

/** What "Waiting on you" lists: reports and alerts are there to read, not answer. */
export const waitingOnOwner = (items: AttentionItem[]): AttentionItem[] =>
  items.filter((item) => item.kind === "approval" || item.kind === "question")

/**
 * The frame's read of the workspace, with only what waits on the owner left
 * in its attention list. It must not take every /app page down with it: a
 * failed read is null, and the panel says it could not load.
 */
export async function readWorkspace(
  read: () => Promise<Workspace>
): Promise<Workspace | null> {
  try {
    const workspace = await read()
    return { ...workspace, attention: waitingOnOwner(workspace.attention) }
  } catch {
    return null
  }
}
