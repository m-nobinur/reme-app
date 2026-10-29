import type { ActivitySegment } from "@workspace/contracts"
import { notStarted, ownerWaits } from "@workspace/ui/lib/activity-copy"
import type { Workspace } from "@/lib/api/types"
import { leading } from "@/lib/briefing"

/** Where a stage on the Tasks page stands. */
export type Status = "done" | "active" | "yours" | "waiting"

export type Task = {
  /** Set for finished work, whose titles can repeat. */
  id?: string
  title: string
  detail: string
  status: Status
  /** Why it cannot start yet, when another task has to finish first. */
  after?: string
  /** When it finished, said in the reader's zone. */
  when?: string | null
}

/**
 * Where a segment stands, as a stage's status; none yet is to come. A
 * segment waits only on the owner, so waiting is theirs to do.
 */
const statusOf = (segment: ActivitySegment | undefined): Status =>
  segment?.state === "done"
    ? "done"
    : segment?.state === "waiting"
      ? "yours"
      : segment && segment.state !== "upcoming" && !notStarted(segment)
        ? "active"
        : "waiting"

/** The stages, each from the activity the panel reads, worded with the assistant's name. */
export function groupsOf(
  workspace: Workspace | null,
  assistant: string
): { id: string; title: string; tasks: Task[] }[] {
  const activity = workspace?.activity
  const journey = activity?.journey ?? []
  const standing = activity?.standing ?? []
  const live = workspace?.live != null
  const begun =
    live ||
    (workspace?.builds.length ?? 0) > 0 ||
    journey.some((s) => s.kind !== "onboarding" && s.state !== "upcoming")
  const onboarding = journey.find((s) => s.kind === "onboarding")
  // Setup is done once a build has begun, whether or not its segment is still read.
  const setup: Status =
    onboarding && onboarding.state !== "done"
      ? statusOf(onboarding)
      : begun || onboarding
        ? "done"
        : "active"
  // A stage waiting on the owner says what, in the panel's words.
  const waits = ownerWaits(activity)
  const needs = (segment: ActivitySegment | undefined) =>
    waits.find((wait) => wait.id === segment?.id)?.title
  const stages = journey.filter(
    (s) =>
      (s.kind === "website" || s.kind === "golive" || s.kind === "change") &&
      s.state !== "upcoming"
  )
  // The build may be done while going live waits: the wait is what shows.
  const owed = stages.map(needs).find(Boolean)
  const site: Status = live
    ? "done"
    : owed
      ? "yours"
      : stages.length > 0
        ? "active"
        : "waiting"
  const address = standing.find((s) => s.kind === "address")
  const google = standing.find((s) => s.kind === "google")
  const after = (status: Status, before: Status, name: string) =>
    status === "waiting" && before !== "done" ? { after: name } : {}
  const domain = statusOf(address)
  const search = statusOf(google)
  return [
    {
      id: "getting-started",
      title: "Getting started",
      tasks: [
        {
          title: "Onboarding",
          detail:
            needs(onboarding) ??
            `Tell ${assistant} about your business, your services and where you work.`,
          status: setup,
        },
      ],
    },
    {
      id: "website",
      title: "Website",
      tasks: [
        {
          title: "Website setup",
          detail:
            (!live && owed) ||
            `${leading(assistant)} builds your first version and you publish it.`,
          status: site,
          ...after(site, setup, "Onboarding"),
        },
        {
          title: "Domain setup",
          detail:
            needs(address) ?? "Point a domain of your own at your website.",
          status: domain,
          ...after(domain, site, "Website setup"),
        },
        {
          title: "Search Console setup",
          detail:
            needs(google) ??
            "Show Google your site so people can find it in search.",
          status: search,
          ...after(search, domain, "Domain setup"),
        },
      ],
    },
    {
      id: "calendar",
      title: "Calendar",
      tasks: [
        {
          title: "Calendar setup",
          detail: "Connect your calendar so bookings land where you work.",
          status: "waiting",
        },
      ],
    },
  ]
}
