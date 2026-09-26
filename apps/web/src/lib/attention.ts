import type { AttentionItem } from "./api/types"

/** What "Waiting on you" lists: reports and alerts are there to read, not answer. */
export const waitingOnOwner = (items: AttentionItem[]): AttentionItem[] =>
  items.filter((item) => item.kind === "approval" || item.kind === "question")

/**
 * The frame's read of what is waiting, which must not take every /app page
 * down with it: a failed read is null, and the panel says it could not load.
 */
export async function readWaiting(
  read: () => Promise<AttentionItem[]>
): Promise<AttentionItem[] | null> {
  try {
    return waitingOnOwner(await read())
  } catch {
    return null
  }
}
