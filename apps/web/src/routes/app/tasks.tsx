import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { PageHeader } from "@workspace/ui/components/app-shell"
import { Badge } from "@workspace/ui/components/badge"
import { StateIcon } from "@workspace/ui/components/status-line"
import { formatDateTime } from "@workspace/ui/lib/format"
import { META } from "@workspace/ui/lib/utils"
import { assistantOf } from "@/lib/briefing"
import { completedOf } from "@/lib/panel"
import { groupsOf, type Task } from "@/lib/tasks"
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

const STATUS = {
  done: { label: "Done", mark: "done" },
  active: { label: "In progress", mark: "working" },
  yours: { label: "Waiting on you", mark: "waiting" },
  waiting: { label: "Up next", mark: "next" },
} as const

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
