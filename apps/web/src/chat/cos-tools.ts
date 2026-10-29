import { browserZone } from "@workspace/ui/lib/zone"
import type { AttentionItem } from "@/lib/api/types"

/**
 * The open questions the cards read, as one string that only changes when a
 * title or the set does: a poll that moves nothing else leaves it alone.
 */
export const questionTitles = (attention: AttentionItem[] = []) =>
  JSON.stringify(
    Object.fromEntries(
      attention.flatMap((item) =>
        item.kind === "question" ? [[item.id, item.title]] : []
      )
    )
  )

/**
 * What the cards need from the app, built from `questionTitles` and the
 * business's zone so it is as stable as they are: times in the zone the
 * assistant set them in.
 */
export const cosTools = (titles: string, zone: string | null = null) => {
  const byId: Record<string, string> = JSON.parse(titles)
  return {
    zone: zone ?? browserZone(),
    question: (requestId: string) => byId[requestId] ?? null,
  }
}
