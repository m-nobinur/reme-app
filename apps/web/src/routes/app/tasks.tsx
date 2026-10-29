import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import type { ActivitySegment } from "@workspace/contracts"
import { PageHeader } from "@workspace/ui/components/app-shell"
import { Badge } from "@workspace/ui/components/badge"
import { StateIcon } from "@workspace/ui/components/status-line"
import { notStarted, ownerWaits } from "@workspace/ui/lib/activity-copy"
import { formatDateTime } from "@workspace/ui/lib/format"
import { META } from "@workspace/ui/lib/utils"
import type { Workspace } from "@/lib/api/types"
import { assistantOf, leading } from "@/lib/briefing"
import { completedOf } from "@/lib/panel"
import { useLiveWorkspace } from "@/lib/workspace"
import { useBrowserZone } from "@/panel/workspace-panel"

/**
 * What the assistant is helping the owner set up. Completed and every
 * stage's state are read from the workspace's activity, the facts the panel
 * reads, and a stage waiting on the owner says what from the same list as
 * the panel's Waiting on you. The panel's Completed links here. Calendar is
 * not tracked yet, so it only says it comes later.
 */
export const Route = createFileRoute("/app/tasks")({
  component: TasksPage,
})

const frame = getRouteApi("/app")

type Status = "done" | "active" | "yours" | "waiting"

const STATUS = {
  done: { label: "Done", mark: "done" },
  active: { label: "In progress", mark: "working" },
  yours: { label: "Waiting on you", mark: "waiting" },
  waiting: { label: "Up next", mark: "next" },
} as const

type Task = {
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

/** Where a segment stands, as a stage's status; none yet is to come. */
const statusOf = (segment: ActivitySegment | undefined): Status =>
  segment?.state === "done"
    ? "done"
    : segment && segment.state !== "upcoming" && !notStarted(segment)
      ? "active"
      : "waiting"

/** The stages, each from the activity the panel reads, worded with the assistant's name. */
function groupsOf(
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

function TaskRow({ task }: { task: Task }) {
  const status = STATUS[task.status]
  return (
    <li className="flex items-start gap-3 rounded-2xl border border-border px-4 py-3.5">
      <StateIcon className="mt-1" state={status.mark} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="font-medium">{task.title}</p>
        <p className="max-w-prose text-muted-foreground text-sm">
          {task.detail}
        </p>
        {task.after ? <p className={META}>Starts after {task.after}.</p> : null}
        {task.when ? <p className={META}>{task.when}</p> : null}
      </div>
      <Badge variant={task.status === "active" ? "default" : "secondary"}>
        {status.label}
      </Badge>
    </li>
  )
}

function TasksPage() {
  const { workspace } = useLiveWorkspace()
  const { active } = frame.useLoaderData()
  const zone = useBrowserZone()
  const assistant = assistantOf(workspace)
  const ctx = {
    seed: active?.id ?? "",
    assistant: workspace?.assistantName ?? null,
  }
  // Times wait for the reader's zone, as the panel's do.
  const completed: Task[] =
    workspace && zone
      ? completedOf(workspace, ctx).map((each) => ({
          id: each.id,
          title: each.text,
          detail: each.brief ?? "",
          status: "done",
          when: formatDateTime(each.at, zone),
        }))
      : []
  const groups = [
    ...(completed.length
      ? [{ id: "completed", title: "Completed", tasks: completed }]
      : []),
    ...groupsOf(workspace, assistant),
  ]
  return (
    <>
      <PageHeader
        description={`What ${assistant} has done and is helping you set up.`}
        title="Tasks"
      />
      <div className="flex flex-col gap-8">
        {groups.map((group) => (
          <section
            aria-labelledby={`tasks-${group.id}`}
            className="scroll-mt-6"
            id={group.id}
            key={group.id}
          >
            <h2 className="mb-3 font-semibold text-sm" id={`tasks-${group.id}`}>
              {group.title}
            </h2>
            <ul className="flex flex-col gap-2">
              {group.tasks.map((task) => (
                <TaskRow key={task.id ?? task.title} task={task} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  )
}
