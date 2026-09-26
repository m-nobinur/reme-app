import type { AttentionItem } from "./api/types"

/** What "Waiting on you" lists: reports and alerts are there to read, not answer. */
export const waitingOnOwner = (items: AttentionItem[]): AttentionItem[] =>
  items.filter((item) => item.kind === "approval" || item.kind === "question")
