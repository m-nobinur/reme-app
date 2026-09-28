import { getRouteApi, Link } from "@tanstack/react-router"
import type {
  BuildSummary,
  DecisionRequest,
  Reminder,
} from "@workspace/contracts"
import { buttonVariants } from "@workspace/ui/components/button"
import {
  AddReminder,
  ApprovalItem,
  ComingUp,
  PanelBlank,
  type Preview,
  QuestionItem,
  ReminderNote,
  Reminders,
  type Thumbnail,
  WaitingOnYou,
  WorkingOn,
  YourWebsite,
} from "@workspace/ui/components/live-panel"
import { factLabel } from "@workspace/ui/lib/facts"
import { cn } from "@workspace/ui/lib/utils"
import { useEffect, useState, useSyncExternalStore } from "react"
import {
  answerQuestion,
  askForChanges,
  cancelBuild,
  completeReminder,
  createReminder,
  decideApproval,
  getPreview,
} from "@/lib/api/server"
import type { AttentionItem, Workspace, WriteOutcome } from "@/lib/api/types"
import { attemptKeys } from "@/lib/attempt"
import { DECISION_REFUSED } from "@/lib/decision"
import { onboardingFor } from "@/lib/onboarding"
import { anchorOf, dueAtOf, noteOf, reminderRows } from "@/lib/reminders"
import { followThumbnail } from "@/lib/thumbnail"
import { useLiveWorkspace } from "@/lib/workspace"

/**
 * The live panel, wired: the sections come from `@workspace/ui`, the reads
 * from the frame's live workspace, and every write goes through a server
 * function and then reads the workspace again, so what the panel shows is
 * always what `/workspace` last said and never a guess about what a write did.
 */

/**
 * The range a build takes, in seconds, as measured when the polling decision
 * was made (owner-workspace.md): 115 to 313 s.
 */
const TYPICAL_BUILD = { min: 115, max: 313 }

const FAILED = "That did not go through. Try again."

/** Where a reminder can point: focusable by script, ringed from the keyboard. */
const TARGET =
  "rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring"

const frame = getRouteApi("/app")

type Refresh = () => Promise<void>
type Approval = Extract<AttentionItem, { kind: "approval" }>
type Question = Extract<AttentionItem, { kind: "question" }>

type Announce = (status: string) => void

/**
 * One write's pending and error state. The write's own refusal is shown as
 * given; a throw is a generic retry. A refusal that means the item is gone
 * is announced at the panel, since the row goes with the next read. Pending
 * lasts until the workspace has been read again, so the row does not flash
 * back to idle before it goes.
 */
function useWrite<Name extends string>(refresh: Refresh, announce?: Announce) {
  const [pending, setPending] = useState<Name | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async (name: Name, write: () => Promise<WriteOutcome>) => {
    setPending(name)
    setError(null)
    try {
      const outcome = await write()
      if (!outcome.done && outcome.gone && announce) {
        announce(outcome.reason)
        await refresh()
        return false
      }
      if (!outcome.done) {
        setError(outcome.reason)
        return false
      }
      await refresh()
      return true
    } catch {
      setError(FAILED)
      return false
    } finally {
      setPending(null)
    }
  }
  return { pending, error, run }
}

/** Who raised an item: the frame's directory knows; a poll names no one. */
function useAsker(item: AttentionItem): string {
  const { names } = frame.useLoaderData()
  return (item.raisedById && names[item.raisedById]) || item.raisedBy
}

function Answerable({
  item,
  refresh,
  announce,
}: {
  item: Question
  refresh: Refresh
  announce: Announce
}) {
  const { pending, error, run } = useWrite<"answer">(refresh, announce)
  // One key per answer until it lands: a retry after a timeout is the same
  // request, and a changed answer is a new one.
  const [keys] = useState(attemptKeys)
  return (
    <QuestionItem
      askedBy={useAsker(item)}
      error={error}
      expiresAt={item.expiresAt}
      onAnswer={(value) =>
        void run("answer", async () => {
          const outcome = await answerQuestion({
            data: {
              assignmentId: item.assignmentId,
              requestId: item.id,
              value,
              key: keys.key(value),
            },
          })
          if (outcome.done) keys.done()
          return outcome
        })
      }
      onExpiry={item.onExpiry}
      pending={pending !== null}
      spec={item.answer}
      title={item.title}
      why={item.detail}
    />
  )
}

/**
 * The preview of the build behind an approval, read when the row mounts,
 * and read again on request after a read that failed.
 */
function usePreview(
  assignmentId: string | null
): [Preview | "loading" | "error", (() => Promise<void>) | undefined] {
  const [preview, setPreview] = useState<Preview | "loading" | "error">(
    "loading"
  )
  const [reads, setReads] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `reads` is the retry's trigger.
  useEffect(() => {
    if (!assignmentId) {
      setPreview("error")
      return
    }
    let current = true
    setPreview("loading")
    getPreview({ data: { assignmentId } }).then(
      (link) => current && setPreview(link ?? "error"),
      () => current && setPreview("error")
    )
    return () => {
      current = false
    }
  }, [assignmentId, reads])
  // With no build to read, a retry would read nothing.
  const retry = assignmentId
    ? async () => setReads((count) => count + 1)
    : undefined
  return [preview, retry]
}

/**
 * The live site's thumbnail, read when the live revision changes and again
 * before its links expire. Loading from the first render when a site is
 * live, so the skeleton holds the space from the server's HTML on.
 */
function useLiveThumbnail(live: Workspace["liveRevision"]): Thumbnail {
  const [thumbnail, setThumbnail] = useState<Thumbnail>(live ? "loading" : null)
  const [follower] = useState(() =>
    followThumbnail({
      read: (assignmentId) => getPreview({ data: { assignmentId } }),
      onChange: setThumbnail,
    })
  )
  useEffect(() => follower.show(live), [follower, live])
  useEffect(() => follower.stop, [follower])
  return thumbnail
}

export function Decidable({
  item,
  refresh,
  announce,
}: {
  item: Approval
  refresh: Refresh
  announce: Announce
}) {
  const { pending, error, run } = useWrite<"approve" | "change">(refresh)
  const [preview, retryPreview] = usePreview(item.request.assignment_id)
  const [keys] = useState(attemptKeys)

  const approve = (decision: DecisionRequest) =>
    void run("approve", async () => {
      const outcome = await decideApproval({
        data: {
          approvalId: item.request.approval_id,
          revisionId: decision.revision_id,
          decision: decision.decision,
        },
      })
      if (!outcome.recorded) {
        return { done: false, reason: DECISION_REFUSED[outcome.reason] }
      }
      announce(`Approved v${item.version}. It is being published.`)
      return { done: true }
    })

  const change = (text: string) =>
    void run("change", async () => {
      const outcome = await askForChanges({
        data: { text, key: keys.key(text) },
      })
      if (outcome.done) {
        keys.done()
        announce(`Sent. A new version replaces v${item.version}.`)
      }
      return outcome
    })

  return (
    <ApprovalItem
      error={error}
      expiresAt={item.request.expires_at}
      onApprove={approve}
      onAskForChanges={change}
      onExpiry={item.onExpiry}
      onRetryPreview={retryPreview}
      pending={pending}
      preview={preview}
      rationale={item.detail}
      target={item.request.target}
      version={item.version}
    />
  )
}

/** The first steps an empty workspace still needs, from its own rows. */
const firstSteps = (workspace: Workspace) => [
  ...workspace.missingFacts.map((key) => ({
    label: factLabel(key),
    done: false,
  })),
  { label: "Build your first version", done: false },
]

/** What closes next: reviews and questions with an expiry, soonest first. */
function comingUp(attention: AttentionItem[]) {
  return attention
    .flatMap((item) =>
      item.expiresAt
        ? [
            {
              id: item.id,
              at: item.expiresAt,
              text:
                item.kind === "approval"
                  ? `Your review of version ${item.version} closes`
                  : `The question about ${item.title.toLowerCase()} closes`,
            },
          ]
        : []
    )
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

/**
 * The build being worked on, with its own Stop state: keyed on the build, so
 * a Stop error never outlives the build it was about.
 */
function Stoppable({
  build,
  queued,
  refresh,
}: {
  build: BuildSummary
  queued: string[]
  refresh: Refresh
}) {
  const stop = useWrite<"stop">(refresh)
  return (
    <WorkingOn
      build={{
        goal: build.goal,
        state: build.state,
        version: build.revision?.version ?? null,
        startedAt: build.created_at,
      }}
      error={stop.error}
      onStop={() =>
        void stop.run("stop", () =>
          cancelBuild({ data: { assignmentId: build.assignment_id } })
        )
      }
      queued={queued}
      stopping={stop.pending !== null}
      typical={TYPICAL_BUILD}
    />
  )
}

/** A blank section's next step, quieter than the primary action. */
const NEXT_STEP = cn(
  buttonVariants({ variant: "outline", size: "sm" }),
  "self-start"
)

/**
 * Where a new owner takes the first step: the getting-started conversation
 * while it is open, or a new chat, whose empty thread offers "Build my
 * website".
 */
function FirstStep({ workspace }: { workspace: Workspace }) {
  const { conversations } = frame.useLoaderData()
  const onboarding = onboardingFor(workspace, conversations)
  return onboarding ? (
    <Link className={NEXT_STEP} params={{ id: onboarding }} to="/app/c/$id">
      Continue getting started
    </Link>
  ) : (
    <Link
      className={NEXT_STEP}
      state={() => ({ chat: crypto.randomUUID() })}
      to="/app"
    >
      Start your website
    </Link>
  )
}

/**
 * The reader's time zone, or null on the server and while hydrating, when it
 * is not known. The server renders no reminder times at all rather than UTC
 * ones the browser would then replace.
 */
const noSubscription = () => () => undefined
function useBrowserZone(): string | null {
  return useSyncExternalStore(
    noSubscription,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    () => null
  )
}

/** A written reminder with its own Done, shown done while the write runs. */
function Completable({
  note,
  zone,
  refresh,
  announce,
}: {
  note: Reminder
  zone: string | null
  refresh: Refresh
  announce: Announce
}) {
  const { pending, error, run } = useWrite<"done">(refresh, announce)
  return (
    <ReminderNote
      {...noteOf(note, zone)}
      error={error}
      onDone={() =>
        void run("done", async () => {
          const outcome = await completeReminder({ data: { id: note.id } })
          if (outcome.done) announce("Marked done.")
          return outcome
        })
      }
      pending={pending !== null}
    />
  )
}

/** The add form: one key per reminder until it lands, as `Answerable` has. */
function Addable({
  refresh,
  announce,
}: {
  refresh: Refresh
  announce: Announce
}) {
  const { pending, error, run } = useWrite<"add">(refresh)
  const [keys] = useState(attemptKeys)
  return (
    <AddReminder
      error={error}
      onAdd={(title, due) =>
        run("add", async () => {
          const dueAt = dueAtOf(due)
          const outcome = await createReminder({
            data: { title, dueAt, key: keys.key({ title, dueAt }) },
          })
          if (outcome.done) {
            keys.done()
            announce("Added to your reminders.")
          }
          return outcome
        })
      }
      pending={pending !== null}
    />
  )
}

/** Written reminders first, in the api's order, then the derived ones. */
function ReminderSection({
  workspace,
  shownBuild,
  refresh,
}: {
  workspace: Workspace
  shownBuild: string | null
  refresh: Refresh
}) {
  const zone = useBrowserZone()
  const [status, setStatus] = useState<string | null>(null)
  return (
    <Reminders
      action={<Addable announce={setStatus} refresh={refresh} />}
      items={reminderRows(workspace, shownBuild, zone)}
      status={status}
    >
      {workspace.reminderNotes.map((note) => (
        <Completable
          announce={setStatus}
          key={note.id}
          note={note}
          refresh={refresh}
          zone={zone}
        />
      ))}
    </Reminders>
  )
}

export function WorkspacePanel() {
  const { workspace, failed, refresh } = useLiveWorkspace()
  const { active } = frame.useLoaderData()
  const [status, setStatus] = useState<string | null>(null)
  const thumbnail = useLiveThumbnail(workspace?.liveRevision ?? null)
  const stale = failed
    ? "This panel did not refresh. It tries again in a minute."
    : null

  if (!workspace) {
    return (
      <WaitingOnYou
        error={stale ?? "This panel did not load."}
        onRetry={refresh}
      />
    )
  }
  const { attention, builds, live, host } = workspace
  if (!live && builds.length === 0 && attention.length === 0) {
    return (
      <>
        <PanelBlank
          action={<FirstStep workspace={workspace} />}
          description={
            workspace.missingFacts.length
              ? "Tell Reme about your business in the chat, then ask it to build your website."
              : "Ask Reme in the chat to build your website."
          }
          steps={firstSteps(workspace)}
        />
        {/* With no organisation there is nowhere to add one to. */}
        {active ? (
          <ReminderSection
            refresh={refresh}
            shownBuild={null}
            workspace={workspace}
          />
        ) : null}
      </>
    )
  }

  const current =
    builds.find((build) => build.state !== "queued") ?? builds.at(-1)
  const queued = builds
    .filter((build) => build !== current && build.state === "queued")
    .map((build) => build.goal)

  return (
    <>
      {current ? (
        <div
          className={TARGET}
          id={anchorOf.build(current.assignment_id)}
          tabIndex={-1}
        >
          <Stoppable
            build={current}
            key={current.assignment_id}
            queued={queued}
            refresh={refresh}
          />
        </div>
      ) : null}
      <WaitingOnYou
        action={
          <Link className={NEXT_STEP} to="/app/notifications">
            See notifications
          </Link>
        }
        error={stale}
        onRetry={refresh}
        status={status}
      >
        {attention.map((item) =>
          item.kind === "approval" ? (
            <div
              className={TARGET}
              id={anchorOf.approval(item.id)}
              key={item.id}
              tabIndex={-1}
            >
              <Decidable announce={setStatus} item={item} refresh={refresh} />
            </div>
          ) : item.kind === "question" ? (
            <div
              className={TARGET}
              id={anchorOf.question(item.id)}
              key={item.id}
              tabIndex={-1}
            >
              <Answerable announce={setStatus} item={item} refresh={refresh} />
            </div>
          ) : null
        )}
      </WaitingOnYou>
      <ComingUp items={comingUp(attention)} />
      <ReminderSection
        refresh={refresh}
        shownBuild={current?.assignment_id ?? null}
        workspace={workspace}
      />
      {live || host ? (
        <YourWebsite host={host} live={live} thumbnail={thumbnail} />
      ) : null}
    </>
  )
}
