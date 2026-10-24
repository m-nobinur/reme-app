import {
  CheckCircleIcon,
  CircleHalfIcon,
  CircleIcon,
} from "@phosphor-icons/react"
import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { PageHeader } from "@workspace/ui/components/app-shell"
import { Badge } from "@workspace/ui/components/badge"
import { formatDateTime } from "@workspace/ui/lib/format"
import { cn, META } from "@workspace/ui/lib/utils"
import { assistantOf, leading } from "@/lib/briefing"
import { completedOf } from "@/lib/panel"
import { useLiveWorkspace } from "@/lib/workspace"
import { useBrowserZone } from "@/panel/workspace-panel"

/**
 * What the assistant is helping the owner set up. Completed is real, read
 * from the workspace's activity, and the panel's Completed links here. The
 * tasks below it are examples: nothing stores or tracks a task yet.
 */
export const Route = createFileRoute("/app/tasks")({
  component: TasksPage,
})

const frame = getRouteApi("/app")

type Status = "done" | "active" | "waiting"

const STATUS = {
  done: { label: "Done", icon: CheckCircleIcon },
  active: { label: "In progress", icon: CircleHalfIcon },
  waiting: { label: "Up next", icon: CircleIcon },
} as const

type Task = {
  title: string
  detail: string
  status: Status
  /** Why it cannot start yet, when another task has to finish first. */
  after?: string
  /** When it finished, said in the reader's zone. */
  when?: string | null
}

/** The tasks, worded with what the owner calls their assistant. */
const groupsOf = (
  assistant: string
): { id: string; title: string; tasks: Task[] }[] => [
  {
    id: "getting-started",
    title: "Getting started",
    tasks: [
      {
        title: "Onboarding",
        detail: `Tell ${assistant} your phone number, industry, services and area.`,
        status: "active",
      },
    ],
  },
  {
    id: "website",
    title: "Website",
    tasks: [
      {
        title: "Website setup",
        detail: `${leading(assistant)} builds your first version and you publish it.`,
        status: "waiting",
        after: "Onboarding",
      },
      {
        title: "Domain setup",
        detail: "Point a domain of your own at your website.",
        status: "waiting",
        after: "Website setup",
      },
      {
        title: "Search Console setup",
        detail: "Show Google your site so people can find it in search.",
        status: "waiting",
        after: "Domain setup",
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

function TaskRow({ task }: { task: Task }) {
  const status = STATUS[task.status]
  return (
    <li className="flex items-start gap-3 rounded-2xl border border-border px-4 py-3.5">
      <status.icon
        aria-hidden
        className={cn(
          "mt-0.5 size-5 shrink-0",
          task.status === "done" ? "text-primary" : "text-muted-foreground"
        )}
        weight={task.status === "done" ? "fill" : "regular"}
      />
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
    orgId: active?.id ?? "",
    assistant: workspace?.assistantName ?? null,
  }
  // Times wait for the reader's zone, as the panel's do.
  const completed: Task[] =
    workspace && zone
      ? completedOf(workspace, ctx).map((each) => ({
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
    ...groupsOf(assistant),
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
                <TaskRow key={`${task.title}${task.when ?? ""}`} task={task} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  )
}
