import type { ActivitySegment } from "@workspace/contracts"
import {
  type CopyContext,
  PAGE_WORDS,
  type PageActionKey,
  pageAction,
  type StatusKind,
  segmentKind,
  standingLine,
} from "@workspace/ui/lib/activity-copy"
import type { Workspace } from "./api/types"
import { dueLine } from "./reminders"

/**
 * The Website page's rows, from the same activity view as the panel, so the
 * two never disagree. Pure: the page draws what this returns, and every
 * word comes from `activity-copy`.
 */

/** Where a row stands, as the panel's steps mark it. */
export type Mark = "done" | "now" | "waiting" | "next" | "failed"

/** A row's one next action: a link, a visit to the approvals, or a line said in the chat. */
export type RowAction =
  | { kind: "visit"; label: string; href: string }
  | { kind: "review"; label: string }
  | { kind: "ask"; label: string; ask: string }

export type CheckRow = {
  id: string
  title: string
  line: string
  mark: Mark
  /** The icon a row at work moves. */
  status: StatusKind
  action: RowAction | null
}

const MARK: Record<ActivitySegment["state"], Mark> = {
  now: "now",
  waiting: "waiting",
  done: "done",
  failed: "failed",
  upcoming: "next",
}

const asked = (key: PageActionKey, subject?: string | null): RowAction => ({
  kind: "ask",
  ...pageAction(key, subject),
})

/** The action a domain, purchase or Google segment offers where it stands. */
function nextAction(
  segment: ActivitySegment,
  subject: string | null
): RowAction | null {
  if (segment.state === "failed") return asked("failed", subject)
  if (segment.state !== "waiting") return null
  switch (segment.kind) {
    case "domain":
      return asked("dns", subject)
    case "purchase":
      return asked("pay", subject)
    case "google":
      return asked("signin")
    default:
      return null
  }
}

export function checklistFor(
  workspace: Workspace,
  zone: string | null,
  now: Date
): CheckRow[] {
  const ctx: CopyContext = { orgId: "", assistant: workspace.assistantName }
  const activity = workspace.activity
  const standing = activity?.standing
  // Times wait for the reader's zone, so the server's HTML and the first
  // browser render agree.
  const when = (at: string) =>
    zone ? dueLine(at, zone, now).replace(/^Today/, "today") : undefined
  const day = (at: string) =>
    zone
      ? new Date(at).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "long",
          year: "numeric",
          timeZone: zone,
        })
      : undefined

  const rows: CheckRow[] = []

  const published = standing?.find((s) => s.kind === "golive")
  const approval = activity?.journey.find(
    (s) => s.kind === "golive" && s.state === "waiting"
  )
  if (published || (workspace.live && !standing)) {
    rows.push({
      id: "published",
      title: PAGE_WORDS.published,
      line: published
        ? standingLine(published, ctx, { when: when(published.at) })
        : PAGE_WORDS.published,
      mark: "done",
      status: "publishing",
      action: workspace.url
        ? { kind: "visit", label: "Visit your website", href: workspace.url }
        : null,
    })
  } else if (approval) {
    rows.push({
      id: "published",
      title: PAGE_WORDS.published,
      line: standingLine(approval, ctx),
      mark: "waiting",
      status: segmentKind(approval),
      action: { kind: "review", label: "Review it" },
    })
  } else {
    rows.push({
      id: "published",
      title: PAGE_WORDS.published,
      line: PAGE_WORDS.notPublished,
      mark: "next",
      status: "publishing",
      action: null,
    })
  }

  const domains =
    standing?.filter(
      (s) =>
        (s.kind === "domain" || s.kind === "purchase") && s.state !== "upcoming"
    ) ?? []
  if (workspace.host) {
    rows.push({
      id: "address",
      title: PAGE_WORDS.address,
      line: workspace.host,
      mark: "done",
      status: "domain",
      action: standing && !domains.length ? asked("own") : null,
    })
  }
  for (const segment of domains) {
    const name = segment.names?.domain ?? null
    const renewal = standing?.find(
      (s) =>
        s.kind === "purchase" &&
        s.state === "upcoming" &&
        s.names?.domain === name
    )
    rows.push({
      id: segment.id,
      title: name ?? "Your domain",
      line: standingLine(segment, ctx, {
        renews: renewal && day(renewal.at),
        until: segment.deadline && when(segment.deadline),
      }),
      mark: MARK[segment.state],
      status: segmentKind(segment),
      action: nextAction(segment, name),
    })
  }

  // Without the standing group (an older api) Google's state is unknown, and
  // "not connected" would be a guess.
  if (standing) {
    const google = standing.find((s) => s.kind === "google")
    rows.push(
      google
        ? {
            id: "google",
            title: PAGE_WORDS.google,
            line: standingLine(google, ctx, {
              synced: google.synced_at && when(google.synced_at),
            }),
            mark: MARK[google.state],
            status: segmentKind(google),
            action: nextAction(google, "Google"),
          }
        : {
            id: "google",
            title: PAGE_WORDS.google,
            line: workspace.live
              ? PAGE_WORDS.notConnected
              : PAGE_WORDS.afterLive,
            mark: "next",
            status: "google",
            action: workspace.live ? asked("google") : null,
          }
    )
  }
  return rows
}
