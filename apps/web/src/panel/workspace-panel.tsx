import { getRouteApi, Link, useRouter } from "@tanstack/react-router"
import type {
  BuildSummary,
  DecisionRequest,
  Reminder,
} from "@workspace/contracts"
import { buttonVariants } from "@workspace/ui/components/button"
import {
  ApprovalItem,
  BUILD_STAGES,
  ComingUp,
  LiveLine,
  PanelBlank,
  PanelDigest,
  type Preview,
  QuestionItem,
  ReminderList,
  ReminderNote,
  type Thumbnail,
  WaitingOnYou,
  WorkingOn,
  YourWebsite,
} from "@workspace/ui/components/live-panel"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@workspace/ui/components/tabs"
import { WORKING } from "@workspace/ui/lib/build-state"
import { factLabel } from "@workspace/ui/lib/facts"
import { cn } from "@workspace/ui/lib/utils"
import { browserZone } from "@workspace/ui/lib/zone"
import {
  type ComponentProps,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import {
  answerQuestion,
  askForChanges,
  cancelBuild,
  completeReminder,
  decideApproval,
  getPreview,
} from "@/lib/api/server"
import type { AttentionItem, Workspace, WriteOutcome } from "@/lib/api/types"
import { attemptKeys } from "@/lib/attempt"
import { askerOf, digestOf } from "@/lib/briefing"
import { DECISION_REFUSED } from "@/lib/decision"
import { onboardingFor } from "@/lib/onboarding"
import { anchorOf, noteOf, upcomingNotes } from "@/lib/reminders"
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
  return askerOf(item, frame.useLoaderData().names)
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

/**
 * The Website tab: the live site, and Request changes, which puts the chat's
 * composer into website change mode: the conversation on screen, or a new
 * one from any other page.
 */
function Website({
  host,
  live,
  thumbnail,
}: {
  host: string | null
  live: number | null
  thumbnail: Thumbnail
}) {
  const router = useRouter()
  const requestChanges = () => {
    const compose = { mode: "site_change" as const, key: crypto.randomUUID() }
    const inChat = router.state.matches.some(
      (match) => match.routeId === "/app/_conversation"
    )
    void router.navigate(
      inChat
        ? { to: ".", state: { compose } }
        : { to: "/app", state: { chat: crypto.randomUUID(), compose } }
    )
  }
  return (
    <YourWebsite
      host={host}
      live={live}
      onRequestChanges={requestChanges}
      thumbnail={thumbnail}
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
 * Where a new owner takes the first step: naming the business when the
 * account has none, the getting-started conversation while it is open, or a
 * new chat, whose empty thread offers "Build my website".
 */
function FirstStep({ workspace }: { workspace: Workspace }) {
  const { conversations, active } = frame.useLoaderData()
  const onboarding = onboardingFor(workspace, conversations)
  // No business yet, as after a first Google sign-in: that comes first.
  if (!active) {
    return (
      <Link className={NEXT_STEP} to="/name-your-business">
        Name your business
      </Link>
    )
  }
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
  return useSyncExternalStore(noSubscription, browserZone, () => null)
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

/** The reminders still ahead, each with its own Done. */
function ReminderSection({
  notes,
  refresh,
}: {
  notes: Reminder[]
  refresh: Refresh
}) {
  const zone = useBrowserZone()
  const [status, setStatus] = useState<string | null>(null)
  return (
    <ReminderList status={status}>
      {notes.map((note) => (
        <Completable
          announce={setStatus}
          key={note.id}
          note={note}
          refresh={refresh}
          zone={zone}
        />
      ))}
    </ReminderList>
  )
}

/**
 * A reminder marked done takes its Done button with it, and its tab too when
 * it was the last. When focus went with it, it moves to the selected tab
 * rather than the page.
 */
function useFocusAfterDone(notes: Reminder[]) {
  const list = useRef<HTMLDivElement>(null)
  const ids = notes.map((note) => note.id).join(" ")
  const before = useRef(ids)
  useEffect(() => {
    const still = ids.split(" ")
    const gone = before.current
      .split(" ")
      .some((id) => id && !still.includes(id))
    before.current = ids
    if (gone && document.activeElement === document.body) {
      list.current
        ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        ?.focus()
    }
  }, [ids])
  return list
}

type Tab = "activity" | "reminders" | "website"

export function WorkspacePanel() {
  const { workspace, failed, refresh } = useLiveWorkspace()
  const { names } = frame.useLoaderData()
  const zone = useBrowserZone()
  const [status, setStatus] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>("activity")
  const thumbnail = useLiveThumbnail(workspace?.liveRevision ?? null)
  const upcoming = upcomingNotes(workspace?.reminderNotes ?? [])
  const tabList = useFocusAfterDone(upcoming)
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
  const blank = !live && builds.length === 0 && attention.length === 0
  const website = live !== null || host !== null
  // A tab that has emptied (its last reminder done) hands back to Activity.
  const shown =
    (tab === "reminders" && upcoming.length) || (tab === "website" && website)
      ? tab
      : "activity"

  const current =
    builds.find((build) => build.state !== "queued") ?? builds.at(-1)
  const queued = builds
    .filter((build) => build !== current && build.state === "queued")
    .map((build) => build.goal)

  const activity = blank ? (
    <PanelBlank
      action={<FirstStep workspace={workspace} />}
      description={
        workspace.missingFacts.length
          ? "Reme builds your website from what you tell it about your business. Share the details below in the chat to get started."
          : "Reme builds your website from a conversation with you. Ask for it in the chat, and you review every version before it goes live."
      }
      steps={firstSteps(workspace)}
    />
  ) : (
    <>
      <PanelDigest
        sentences={digestOf(workspace, names, zone ? new Date() : null)}
      />
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
      <WaitingOnYou error={stale} onRetry={refresh} status={status}>
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
    </>
  )

  return (
    <Tabs onValueChange={(value: Tab) => setTab(value)} value={shown}>
      <TabsList className="sticky top-0 z-10 bg-popover" ref={tabList}>
        <TabsTrigger value="activity">Activity</TabsTrigger>
        {upcoming.length ? (
          <TabsTrigger value="reminders">
            Reminders
            <span className="text-muted-foreground tabular-nums">
              {upcoming.length}
            </span>
          </TabsTrigger>
        ) : null}
        {website ? <TabsTrigger value="website">Website</TabsTrigger> : null}
      </TabsList>
      {/* Kept mounted, so a half-written answer or an open Stop question
          survives a look at another tab. */}
      <TabsContent keepMounted value="activity">
        {activity}
      </TabsContent>
      {upcoming.length ? (
        <TabsContent value="reminders">
          <ReminderSection notes={upcoming} refresh={refresh} />
        </TabsContent>
      ) : null}
      {website ? (
        <TabsContent value="website">
          <Website host={host} live={live} thumbnail={thumbnail} />
        </TabsContent>
      ) : null}
    </Tabs>
  )
}

/**
 * What the panel's one line says, most pressing first: the build being
 * worked on, then a review, then a question, then where the site stands.
 * The dot follows the site: pulsing while a build works, the accent while a
 * version is live.
 */
export function lineOf(
  workspace: Workspace | null,
  names: Record<string, string>
): ComponentProps<typeof LiveLine> {
  if (!workspace) return { tone: "idle", lead: "This panel did not load" }
  const tone = workspace.live ? "live" : "idle"
  const build = workspace.builds.find((each) => WORKING.has(each.state))
  if (build) {
    const version = build.revision?.version
    return {
      tone: "working",
      lead: version
        ? `Building version ${version},`
        : workspace.live
          ? "Building a new version,"
          : "Building your first version,",
      detail: BUILD_STAGES[build.state].note.toLowerCase().slice(0, -1),
    }
  }
  const approvals = workspace.attention.flatMap((item) =>
    item.kind === "approval" ? [item] : []
  )
  const [approval] = approvals
  if (approval) {
    return {
      tone,
      lead:
        approvals.length === 1
          ? `Version ${approval.version} is ready`
          : `${approvals.length} versions are ready`,
      detail: "for your review",
    }
  }
  const questions = workspace.attention.flatMap((item) =>
    item.kind === "question" ? [item] : []
  )
  const [question] = questions
  if (question) {
    return questions.length === 1
      ? {
          tone,
          lead: askerOf(question, names),
          detail: "has a question for you",
        }
      : { tone, lead: `${questions.length} questions`, detail: "for you" }
  }
  if (workspace.live) {
    return {
      tone,
      lead: "Your website is live",
      detail: `on version ${workspace.live}`,
    }
  }
  return workspace.open
    ? { tone, lead: "Your first website", detail: "is under way" }
    : { tone, lead: "Let's get your website started" }
}

/** The panel in one line, for the shell's header and its minimised state. */
export function WorkspacePanelLine() {
  const { workspace } = useLiveWorkspace()
  const { names } = frame.useLoaderData()
  return <LiveLine {...lineOf(workspace, names)} />
}
