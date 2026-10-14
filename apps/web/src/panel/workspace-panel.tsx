import { ArrowSquareOutIcon } from "@phosphor-icons/react"
import {
  getRouteApi,
  Link,
  useMatches,
  useParams,
  useRouter,
} from "@tanstack/react-router"
import type {
  Blueprint,
  BuildSummary,
  DecisionRequest,
  Reminder,
} from "@workspace/contracts"
import { buttonVariants } from "@workspace/ui/components/button"
import {
  ApprovalItem,
  ComingUp,
  LiveLine,
  NextSteps,
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
import { browserZone } from "@workspace/ui/lib/zone"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
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
import { askerOf } from "@/lib/briefing"
import { DECISION_REFUSED } from "@/lib/decision"
import { type Panel, panelFor, type Suggestion } from "@/lib/panel"
import { anchorOf, noteOf, upcomingNotes } from "@/lib/reminders"
import { followThumbnail } from "@/lib/thumbnail"
import { useLiveWorkspace } from "@/lib/workspace"
import { photoActions } from "./photo-actions"

/**
 * The live panel, wired: the sections come from `@workspace/ui`, the reads
 * from the frame's live workspace, and every write goes through a server
 * function and then reads the workspace again, so what the panel shows is
 * always what `/workspace` last said and never a guess about what a write did.
 */

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
export function useLiveThumbnail(live: Workspace["liveRevision"]): Thumbnail {
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

  const photos = (item.photos ?? []).length > 0
  return (
    <ApprovalItem
      error={error}
      expiresAt={item.request.expires_at}
      onApprove={approve}
      onAskForChanges={change}
      onExpiry={item.onExpiry}
      onRetryPreview={retryPreview}
      pending={pending}
      photoActions={
        photos
          ? photoActions((write) => {
              void run("change", async () => {
                const outcome = await write()
                if (outcome.done)
                  announce("Sent. A new version replaces this one.")
                return outcome
              })
            })
          : undefined
      }
      photos={item.photos ?? []}
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
  blueprint,
}: {
  host: string | null
  live: number | null
  thumbnail: Thumbnail
  blueprint: Blueprint | null
}) {
  return (
    <YourWebsite
      blueprint={blueprint}
      host={host}
      live={live}
      onRequestChanges={useRequestChanges()}
      thumbnail={thumbnail}
    />
  )
}

/**
 * Request changes, wherever it is pressed: the composer on screen takes
 * website change mode, or a new chat opens with it from any other page.
 */
export function useRequestChanges() {
  const router = useRouter()
  return () => {
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
}

/**
 * The build being worked on, with its own Stop state: keyed on the build, so
 * a Stop error never outlives the build it was about.
 */
function Stoppable({
  build,
  queued,
  expected,
  refresh,
}: {
  build: BuildSummary
  queued: string[]
  expected: Workspace["expectedSeconds"]
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
        lane: build.lane ?? "full",
        fellThrough: build.fell_through,
        activity: build.activity ?? [],
        plan: build.blueprint?.plan,
        awaitingReview: build.blueprint?.awaiting ?? false,
        photos: build.photos,
        reviewMs: build.review_ms,
        endedAt: build.updated_at,
      }}
      error={stop.error}
      expectedSeconds={expected?.[build.lane ?? "full"]}
      onStop={() =>
        void stop.run("stop", () =>
          cancelBuild({ data: { assignmentId: build.assignment_id } })
        )
      }
      queued={queued}
      stopping={stop.pending !== null}
    />
  )
}

/** A next step, quieter than the primary action. */
const NEXT_STEP = buttonVariants({ variant: "outline", size: "sm" })

/** What "Set a reminder" asks in a new chat: reminders are set there. */
const REMINDER_PROMPT = "Set a reminder for me"

/** One of the model's next steps, as the link or button that takes it. */
function Suggested({ suggestion }: { suggestion: Suggestion }) {
  const requestChanges = useRequestChanges()
  switch (suggestion.kind) {
    case "name-business":
      return (
        <Link className={NEXT_STEP} to="/name-your-business">
          Name your business
        </Link>
      )
    case "onboarding":
      return (
        <Link
          className={NEXT_STEP}
          params={{ id: suggestion.id }}
          to="/app/c/$id"
        >
          Continue getting started
        </Link>
      )
    case "start-website":
      // A new chat, whose empty thread offers "Build my website".
      return (
        <Link
          className={NEXT_STEP}
          state={() => ({ chat: crypto.randomUUID() })}
          to="/app"
        >
          Start your website
        </Link>
      )
    case "request-change":
      return (
        <button
          className={NEXT_STEP}
          // It moves the owner to the composer, so the phone sheet goes.
          data-leaves-panel
          onClick={requestChanges}
          type="button"
        >
          Request a change
        </button>
      )
    case "visit-site":
      return (
        <a
          className={NEXT_STEP}
          href={`https://${suggestion.host}`}
          rel="noreferrer"
          target="_blank"
          title={suggestion.host}
        >
          Visit your website
          <span className="sr-only"> (opens in a new tab)</span>
          <ArrowSquareOutIcon aria-hidden className="text-muted-foreground" />
        </a>
      )
    case "set-reminder":
      return (
        <Link
          className={NEXT_STEP}
          state={() => ({ chat: crypto.randomUUID(), ask: REMINDER_PROMPT })}
          to="/app"
        >
          Set a reminder
        </Link>
      )
  }
}

/**
 * The reader's time zone, or null on the server and while hydrating, when it
 * is not known. The server renders no reminder times at all rather than UTC
 * ones the browser would then replace.
 */
const noSubscription = () => () => undefined
export function useBrowserZone(): string | null {
  return useSyncExternalStore(noSubscription, browserZone, () => null)
}

/** A written reminder with its own Done, shown done while the write runs. */
export function Completable({
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

/**
 * What the panel says on the page the owner is on, from reads the frame
 * already holds. Null when there is nothing worth a panel there, or when the
 * workspace could not be read, which the panel says on its own.
 */
export function usePanel(workspace: Workspace | null): Panel | null {
  const { active, conversations, activity, names } = frame.useLoaderData()
  const route = useMatches({ select: (matches) => matches.at(-1)?.routeId })
  const { id } = useParams({ strict: false })
  const zone = useBrowserZone()
  if (!workspace) return null
  return panelFor({
    route,
    conversation: id,
    workspace,
    business: active?.name ?? null,
    conversations,
    activity,
    names,
    now: new Date(),
    zone,
  })
}

export function WorkspacePanel({ panel }: { panel: Panel | null }) {
  const { workspace, failed, refresh } = useLiveWorkspace()
  const zone = useBrowserZone()
  const [status, setStatus] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>("activity")
  const thumbnail = useLiveThumbnail(workspace?.liveRevision ?? null)
  const upcoming = upcomingNotes(workspace?.reminderNotes ?? [])
  const tabList = useFocusAfterDone(upcoming)
  const stale = failed
    ? "This panel did not refresh. It tries again in a minute."
    : null

  if (!workspace || !panel) {
    return (
      <WaitingOnYou
        error={stale ?? "This panel did not load."}
        onRetry={refresh}
      />
    )
  }
  const { live, host } = workspace
  const website = live !== null || host !== null
  // The newest build that planned. Builds are unfinished ones only, so the
  // plan leaves the panel once its build ends.
  const blueprint =
    workspace.builds.find((b) => b.blueprint)?.blueprint?.plan ?? null
  // A tab that has emptied (its last reminder done) hands back to Activity.
  const shown =
    (tab === "reminders" && upcoming.length) || (tab === "website" && website)
      ? tab
      : "activity"

  const { build } = panel
  const activity = (
    <>
      <PanelDigest sentences={panel.headline} />
      {panel.steps ? <PanelBlank steps={panel.steps} /> : null}
      {build ? (
        <div
          className={TARGET}
          id={anchorOf.build(build.assignment_id)}
          tabIndex={-1}
        >
          <Stoppable
            build={build}
            expected={workspace.expectedSeconds}
            key={build.assignment_id}
            queued={panel.queued}
            refresh={refresh}
          />
        </div>
      ) : null}
      <WaitingOnYou error={stale} onRetry={refresh} status={status}>
        {panel.waiting.map((item) =>
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
      <ComingUp items={panel.upcoming} zone={zone} />
      <ComingUp items={panel.latest} title="Latest" zone={zone} />
      <NextSteps>
        {panel.suggestions.map((suggestion) => (
          <Suggested key={suggestion.kind} suggestion={suggestion} />
        ))}
      </NextSteps>
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
          <Website
            blueprint={blueprint}
            host={host}
            live={live}
            thumbnail={thumbnail}
          />
        </TabsContent>
      ) : null}
    </Tabs>
  )
}

/** The panel in one line, for its header and its minimised state. */
export function WorkspacePanelLine({ panel }: { panel: Panel | null }) {
  return (
    <LiveLine
      {...(panel?.line ?? { tone: "idle", lead: "This panel did not load" })}
    />
  )
}

/**
 * Says the panel's line to a screen reader when what it says changes on the
 * same page: a build starting, a version ready, a question. Not on a
 * navigation, where the line changes because the page did, and not on a
 * build's next stage, which the stepper says while the panel is open.
 */
export function PanelAnnouncer({ panel }: { panel: Panel | null }) {
  const route = useMatches({ select: (matches) => matches.at(-1)?.routeId })
  const line = panel?.line ?? null
  const lead = line?.lead ?? null
  const [said, setSaid] = useState("")
  const last = useRef({ route, lead })
  useEffect(() => {
    const before = last.current
    last.current = { route, lead }
    if (line && route === before.route && lead !== before.lead) {
      setSaid(line.detail ? `${line.lead} ${line.detail}` : line.lead)
    }
  }, [route, lead, line])
  return (
    <p className="sr-only" role="status">
      {said}
    </p>
  )
}
