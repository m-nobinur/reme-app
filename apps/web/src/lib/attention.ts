import type { AttentionItem } from "./api/types"

/** What the "Waiting on you" tile counts: reports and alerts are there to read, not answer. */
export const waitingOnOwner = (items: AttentionItem[]): number =>
  items.filter((item) => item.kind === "approval" || item.kind === "question")
    .length
