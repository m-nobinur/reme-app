import {
  CheckCircleIcon,
  CircleHalfIcon,
  CircleIcon,
} from "@phosphor-icons/react"
import { createFileRoute } from "@tanstack/react-router"
import { PageHeader } from "@workspace/ui/components/app-shell"
import { Badge } from "@workspace/ui/components/badge"
import { cn, META } from "@workspace/ui/lib/utils"

/**
 * What Reme is helping the owner set up. The tasks below are examples: nothing
 * stores or tracks a task yet, so this page reads no workspace state.
 */
export const Route = createFileRoute("/app/tasks")({
  component: TasksPage,
})

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
}

const GROUPS: { id: string; title: string; tasks: Task[] }[] = [
  {
    id: "getting-started",
    title: "Getting started",
    tasks: [
      {
        title: "Onboarding",
        detail: "Tell Reme your phone number, industry, services and area.",
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
        detail: "Reme builds your first version and you publish it.",
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
      </div>
      <Badge variant={task.status === "active" ? "default" : "secondary"}>
        {status.label}
      </Badge>
    </li>
  )
}

function TasksPage() {
  return (
    <>
      <PageHeader
        description="What Reme is helping you set up, in the order it happens."
        title="Tasks"
      />
      <div className="flex flex-col gap-8">
        {GROUPS.map((group) => (
          <section aria-labelledby={`tasks-${group.id}`} key={group.id}>
            <h2 className="mb-3 font-semibold text-sm" id={`tasks-${group.id}`}>
              {group.title}
            </h2>
            <ul className="flex flex-col gap-2">
              {group.tasks.map((task) => (
                <TaskRow key={task.title} task={task} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  )
}
