import { ClockIcon } from "@phosphor-icons/react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { PageHeader } from "@workspace/ui/components/app-shell"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { EmptyState } from "@workspace/ui/components/empty-state"
import { ReminderList } from "@workspace/ui/components/live-panel"
import { META } from "@workspace/ui/lib/utils"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { groupReminders, type Needed } from "@/lib/reminders"
import { useLiveWorkspace } from "@/lib/workspace"
import { Completable, useBrowserZone } from "@/panel/workspace-panel"

/**
 * Every open reminder: what the workspace says needs the owner now, then the
 * written ones by when they are due. It reads nothing of its own: the
 * frame's live workspace holds both, and each written reminder is completed
 * exactly as the panel completes it.
 */
export const Route = createFileRoute("/app/reminders")({
  component: RemindersPage,
})

const ACTION = buttonVariants({ variant: "outline", size: "sm" })

/** A group of the page: its heading, with how many it holds. */
function Group({
  id,
  title,
  count,
  children,
}: {
  id: string
  title: string
  count: number
  children: ReactNode
}) {
  return (
    <section aria-labelledby={`reminders-${id}`} className="flex flex-col">
      <h2
        className="flex items-baseline gap-2 font-semibold text-sm"
        id={`reminders-${id}`}
      >
        {title}
        <span className="font-normal text-muted-foreground tabular-nums">
          {count}
        </span>
      </h2>
      {children}
    </section>
  )
}

/** Where a derived reminder is acted on: the panel, or a new chat. */
const actionOf = ({ action }: Needed) =>
  "focus" in action ? (
    <Link
      className={ACTION}
      state={() => ({
        panel: { key: crypto.randomUUID(), focus: action.focus },
      })}
      to="/app"
    >
      {action.label}
    </Link>
  ) : (
    <Link
      className={ACTION}
      state={() => ({ chat: crypto.randomUUID() })}
      to="/app"
    >
      {action.label}
    </Link>
  )

function Reminders() {
  const { workspace, refresh } = useLiveWorkspace()
  const zone = useBrowserZone()
  const [status, setStatus] = useState<string | null>(null)
  const announcer = useRef<HTMLParagraphElement>(null)
  const ids = (workspace?.reminderNotes ?? []).map((note) => note.id).join(" ")
  const before = useRef(ids)

  // A reminder marked done takes its Done button with it. When focus went
  // with it, it moves to the line that says so rather than the page.
  useEffect(() => {
    const gone = before.current
      .split(" ")
      .some((id) => id && !ids.split(" ").includes(id))
    before.current = ids
    if (gone && document.activeElement === document.body) {
      announcer.current?.focus()
    }
  }, [ids])

  if (!workspace) {
    return (
      <EmptyState
        action={
          <Button onClick={() => void refresh()} variant="outline">
            Try again
          </Button>
        }
        description="Reminders could not be loaded. Nothing was changed."
        icon={<ClockIcon />}
        role="alert"
        title="Something went wrong"
      />
    )
  }

  // The server renders no times and no days: they wait for the reader's zone.
  const { needed, groups } = groupReminders(
    workspace.reminderNotes,
    workspace.derivedReminders,
    workspace.attention,
    zone
  )

  return (
    <>
      <PageHeader
        description="What needs you now, and the reminders you or Reme wrote down, by when they are due."
        title="Reminders"
      />

      <p
        className="mb-4 text-sm outline-none empty:hidden"
        ref={announcer}
        role="status"
        tabIndex={-1}
      >
        {status}
      </p>

      {needed.length === 0 && groups.length === 0 ? (
        <EmptyState
          description="To add one, start a chat and pick Remind me from the + menu."
          icon={<ClockIcon />}
          title="No reminders"
        />
      ) : (
        <div className="flex flex-col gap-8">
          {needed.length ? (
            <Group count={needed.length} id="now" title="Needs you now">
              <ul className="flex flex-col divide-y divide-border">
                {needed.map((item) => (
                  <li className="flex items-start gap-3 py-2.5" key={item.key}>
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="wrap-break-word font-medium text-sm">
                        {item.title}
                      </span>
                      <span className={META}>{item.detail}</span>
                    </div>
                    {actionOf(item)}
                  </li>
                ))}
              </ul>
            </Group>
          ) : null}
          {groups.map((group) => (
            <Group
              count={group.notes.length}
              id={group.id}
              key={group.id}
              title={group.title}
            >
              <ReminderList>
                {group.notes.map((note) => (
                  <Completable
                    announce={setStatus}
                    key={note.id}
                    note={note}
                    refresh={refresh}
                    zone={zone}
                  />
                ))}
              </ReminderList>
            </Group>
          ))}
        </div>
      )}
    </>
  )
}

/**
 * The page keeps to the composer's width and the left edge every page title
 * shares, so its actions stay clear of the panel floating at the top right.
 */
function RemindersPage() {
  return (
    <div className="max-w-2xl">
      <Reminders />
    </div>
  )
}
