import { browserZone } from "@workspace/ui/lib/zone"
import type { AttentionItem, Workspace } from "@/lib/api/types"
import { ownDomainLive } from "@/lib/website-checklist"

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

/**
 * What the cards' live state is read from, as one string that changes only
 * when it does: whether Google is signed in (null before the api says), the
 * domains the website is live on, and the open reminders (null unread).
 */
export const liveKey = (workspace: Workspace | null | undefined) => {
  const standing = workspace?.activity?.standing
  return JSON.stringify({
    google: standing
      ? standing.some(
          (s) =>
            s.kind === "google" &&
            s.steps.some(
              (step) => step.id === "sign_in" && step.state === "done"
            )
        )
      : null,
    domains: (standing ?? []).flatMap((s) =>
      s.kind === "address" &&
      s.names?.domain &&
      ownDomainLive([s], workspace?.host ?? null)
        ? [s.names.domain]
        : []
    ),
    reminders: workspace ? workspace.reminderNotes.map((r) => r.id) : null,
  })
}

/** The cards' live state from `liveKey`. */
export const liveState = (key: string) => {
  const live: {
    google: boolean | null
    domains: string[]
    reminders: string[] | null
  } = JSON.parse(key)
  const domains = new Set(live.domains)
  const reminders = live.reminders && new Set(live.reminders)
  return {
    cards: {
      googleConnected: live.google,
      domainLive: (name: string) => domains.has(name),
    },
    reminderOpen: reminders ? (id: string) => reminders.has(id) : undefined,
  }
}
