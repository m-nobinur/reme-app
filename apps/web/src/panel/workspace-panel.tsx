import {
  ArrowSquareOutIcon,
  ChatCircleDotsIcon,
  ChatCircleTextIcon,
  CheckCircleIcon,
  PulseIcon,
} from "@phosphor-icons/react"
import {
  getRouteApi,
  Link,
  useMatches,
  useParams,
  useRouter,
} from "@tanstack/react-router"
import {
  type AvatarId,
  type BuildSummary,
  type DecisionRequest,
  type Reminder,
  revisionPictures,
} from "@workspace/contracts"
import { useDockedQuestion } from "@workspace/ui/components/assistant/question-tray"
import { AssistantAvatar } from "@workspace/ui/components/assistant-avatar"
import { buttonVariants } from "@workspace/ui/components/button"
import {
  ApprovalItem,
  ComingUp,
  LiveLine,
  NextSteps,
  PanelSegment,
  type Preview,
  QuestionItem,
  ReminderList,
  ReminderNote,
  SECTION_ACTION,
  type SegmentStep,
  StageDetail,
  StopBuild,
  type Thumbnail,
  UpNext,
  WaitingOnYou,
  YourWebsite,
} from "@workspace/ui/components/live-panel"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@workspace/ui/components/tabs"
import { Hint } from "@workspace/ui/components/tooltip"
import { useSiteName } from "@workspace/ui/lib/site-name"
import { cn } from "@workspace/ui/lib/utils"
import { browserZone } from "@workspace/ui/lib/zone"
import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { lastChat } from "@/chat/history"
import {
  cancelBuild,
  completeReminder,
  decideApproval,
  getPreview,
} from "@/lib/api/server"
import type { AttentionItem, Workspace, WriteOutcome } from "@/lib/api/types"
import { DECISION_REFUSED } from "@/lib/decision"
import {
  type Panel,
  panelFor,
  type SegmentView,
  type Suggestion,
} from "@/lib/panel"
import { anchorOf, noteOf, upcomingNotes } from "@/lib/reminders"
import { useLiveWorkspace } from "@/lib/workspace"
import { useFollowStep } from "./follow-step"
import { everyMinute, thisMoment } from "./minute-clock"

/**
 * The live panel, wired: the sections come from `@workspace/ui`, the reads
 * from the frame's live workspace, and every write goes through a server
 * function and then reads the workspace again, so what the panel shows is
 * always what `/workspace` last said and never a guess about what a write did.
 */

const FAILED = "That didn't go through. Try again."

/** How many of each Activity list show before the rest: in place for Now, on their own page for the others. */
const SHOWN = { now: 3, upcoming: 4, done: 5 } as const

/** Where a reminder can point: focusable by script, ringed from the keyboard. */
const TARGET =
  "rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring"

const frame = getRouteApi("/app")

type Refresh = () => Promise<void>
type Approval = Extract<AttentionItem, { kind: "approval" }>

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

const ANSWER = cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-1")

/**
 * A question's way to its card in the chat: in this thread the docked card
 * opens and takes the keyboard; elsewhere the latest chat opens, where the
 * card docks and takes it itself.
 */
function AnswerInChat() {
  const docked = useDockedQuestion()
  const chat = lastChat(frame.useLoaderData().conversations)
  if (docked) {
    return (
      <button className={ANSWER} onClick={docked.open} type="button">
        Answer in the chat
      </button>
    )
  }
  return chat ? (
    <Link className={ANSWER} params={{ id: chat.id }} to="/app/c/$id">
      Answer in the chat
    </Link>
  ) : null
}

/**
 * The preview of the build behind an approval, read when the row mounts,
 * and read again on request after a read that failed.
 */
export function usePreview(
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

/** The live site's thumbnail: its home page on a laptop, served by its revision. */
export const liveThumbnail = (live: Workspace["liveRevision"]): Thumbnail =>
  live ? { src: revisionPictures(live.revisionId).laptop } : null

export function Decidable({
  item,
  refresh,
  announce,
}: {
  item: Approval
  refresh: Refresh
  announce: Announce
}) {
  const { pending, error, run } = useWrite<"approve">(refresh)
  const [preview, retryPreview] = usePreview(item.request.assignment_id)
  const business = useSiteName()

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
      announce("Approved. Your website is being published.")
      return { done: true }
    })

  return (
    <ApprovalItem
      error={error}
      onApprove={approve}
      onRetryPreview={retryPreview}
      pending={pending !== null}
      pictures={
        item.request.target.kind === "revision"
          ? revisionPictures(item.request.target.revision_id)
          : null
      }
      preview={preview}
      target={item.request.target}
      title={business ?? "Your website"}
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
  url,
  live,
  thumbnail,
}: {
  host: string | null
  url: string | null
  live: number | null
  thumbnail: Thumbnail
}) {
  return (
    <YourWebsite
      host={host}
      live={live}
      onRequestChanges={useRequestChanges()}
      url={url}
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
 * A build's Stop, with its own state: keyed on the build, so a Stop error
 * never outlives the build it was about.
 */
function Stoppable({
  build,
  refresh,
}: {
  build: BuildSummary
  refresh: Refresh
}) {
  const stop = useWrite<"stop">(refresh)
  return (
    <StopBuild
      error={stop.error}
      fellThrough={build.fell_through}
      lane={build.lane}
      onStop={() =>
        void stop.run("stop", () =>
          cancelBuild({ data: { assignmentId: build.assignment_id } })
        )
      }
      state={build.state}
      stopping={stop.pending !== null}
    />
  )
}

/** A segment's steps, with what the website's stages decided and made under them. */
function stepsOf({ kind, steps, build }: SegmentView): SegmentStep[] {
  if (kind !== "website" || !build) return steps
  return steps.map((step) => ({
    ...step,
    detail: (
      <StageDetail
        activity={build.activity ?? []}
        photos={build.photos}
        plan={build.blueprint?.plan}
        stage={step.id}
        state={step.state}
      />
    ),
  }))
}

/**
 * One segment, with what the owner can do in it: Stop while its build
 * runs, and whatever the caller adds, such as a review's buttons. A build's
 * segment is where the build's anchor points.
 */
function Segment({
  segment,
  refresh,
  children,
}: {
  segment: SegmentView
  refresh: Refresh
  children?: ReactNode
}) {
  const { build } = segment
  return (
    <div
      className={TARGET}
      id={build ? anchorOf.build(build.assignment_id) : undefined}
      tabIndex={build ? -1 : undefined}
    >
      <PanelSegment
        icon={segment.icon}
        line={segment.line}
        state={segment.state}
        steps={stepsOf(segment)}
        title={segment.title}
        working={segment.working}
      >
        {build && segment.state !== "done" ? (
          <Stoppable
            build={build}
            key={build.assignment_id}
            refresh={refresh}
          />
        ) : null}
        {children}
      </PanelSegment>
    </div>
  )
}

/** A next step, quieter than the primary action. */
const NEXT_STEP = buttonVariants({ variant: "outline", size: "sm" })

/** One of the model's next steps, as the link or button that takes it. */
function Suggested({ suggestion }: { suggestion: Suggestion }) {
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
          Finish setting up
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
    case "visit-site":
      return (
        <a
          className={NEXT_STEP}
          href={suggestion.url}
          rel="noreferrer"
          target="_blank"
          title={suggestion.host}
        >
          Visit your website
          <span className="sr-only"> (opens in a new tab)</span>
          <ArrowSquareOutIcon aria-hidden className="text-muted-foreground" />
        </a>
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
  const { active, conversations } = frame.useLoaderData()
  const route = useMatches({ select: (matches) => matches.at(-1)?.routeId })
  const { id } = useParams({ strict: false })
  const zone = useBrowserZone()
  // Re-renders as the minute turns, so elapsed and relative times move while the workspace holds still.
  const now = useSyncExternalStore(everyMinute, thisMoment, thisMoment)
  if (!workspace) return null
  return panelFor({
    route,
    conversation: id,
    workspace,
    orgId: active?.id ?? null,
    business: active?.name ?? null,
    conversations,
    now: new Date(now),
    zone,
  })
}

/**
 * What the owner last did, said until the state it describes moves on. The
 * first read after the line is said fixes that state; the next change to it
 * (the review leaves, the build goes live) clears the line.
 */
export function useAnnouncement(workspace: Workspace | null) {
  const [said, setSaid] = useState<{ text: string; since: string } | null>(null)
  const state = workspace
    ? [
        workspace.live,
        ...workspace.attention.map((item) => item.id),
        ...workspace.builds.map((b) => `${b.assignment_id}${b.state}`),
      ].join(" ")
    : ""
  useEffect(() => {
    setSaid((now) =>
      !now ? now : now.since === "" ? { ...now, since: state } : null
    )
  }, [state])
  return [
    said?.text ?? null,
    (text: string) => setSaid({ text, since: "" }),
  ] as const
}

export function WorkspacePanel({ panel }: { panel: Panel | null }) {
  const { workspace, failed, refresh } = useLiveWorkspace()
  const zone = useBrowserZone()
  const [status, setStatus] = useAnnouncement(workspace)
  const [tab, setTab] = useState<Tab>("activity")
  const thumbnail = liveThumbnail(workspace?.liveRevision ?? null)
  const upcoming = upcomingNotes(workspace?.reminderNotes ?? [])
  const tabList = useFocusAfterDone(upcoming)
  const activityTab = useRef<HTMLDivElement>(null)
  useFollowStep(activityTab)
  const stale = failed ? "Couldn't refresh. Trying again in a minute." : null

  if (!workspace || !panel) {
    return (
      <WaitingOnYou
        error={stale ?? "Couldn't load this panel."}
        onRetry={refresh}
      />
    )
  }
  const { live, host } = workspace
  const website = live !== null || host !== null
  // A tab that has emptied (its last reminder done) hands back to Activity.
  const shown =
    (tab === "reminders" && upcoming.length) || (tab === "website" && website)
      ? tab
      : "activity"

  const segment = (each: SegmentView) => (
    <Segment key={each.id} refresh={refresh} segment={each}>
      {/* The first version's review is the going-live segment's first step. */}
      {each.kind === "golive" && panel.review ? (
        <div
          className={TARGET}
          id={anchorOf.approval(panel.review.id)}
          tabIndex={-1}
        >
          <Decidable
            announce={setStatus}
            item={panel.review}
            refresh={refresh}
          />
        </div>
      ) : null}
      {/* Setup is done and no build runs (a first build was stopped): its
          one next action, asked in the chat as the Website page asks it. */}
      {each.kind === "website" && each.state === "upcoming" ? (
        <Link
          className={cn(NEXT_STEP, "self-start")}
          state={() => ({ chat: crypto.randomUUID(), ask: "Build my website" })}
          to="/app"
        >
          Create my website
        </Link>
      ) : null}
    </Segment>
  )
  // The first run's segment waits on the owner (the publish review) or is at work.
  const held = panel.journey.filter((each) => each.state === "waiting")
  const going = panel.journey.filter((each) => each.state !== "waiting")
  const row = (each: SegmentView) => (
    <div className="py-3" key={each.id}>
      {segment(each)}
    </div>
  )
  const activity = (
    <>
      {/* What waits on the owner comes first: the first run's publish
          review, every question and approval, then the jobs blocked on them.
          The first three kinds never sit behind "Show more": links and the
          pill focus them by their anchors. */}
      <WaitingOnYou
        icon={ChatCircleDotsIcon}
        limit={Math.max(SHOWN.now, held.length + panel.waiting.length)}
        status={status}
      >
        {held.map(row)}
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
              <QuestionItem action={<AnswerInChat />} title={item.title} />
            </div>
          ) : null
        )}
        {panel.blocked.map(row)}
      </WaitingOnYou>
      <WaitingOnYou
        error={stale}
        icon={PulseIcon}
        limit={SHOWN.now}
        onRetry={refresh}
        title="Now"
      >
        {[...going, ...panel.now].map(row)}
      </WaitingOnYou>
      {panel.upNext ? (
        <UpNext text={panel.upNext.text}>
          <Link
            className={NEXT_STEP}
            state={() => ({
              chat: crypto.randomUUID(),
              ask: panel.upNext?.ask,
            })}
            to="/app"
          >
            {panel.upNext.label}
          </Link>
        </UpNext>
      ) : null}
      <ComingUp
        action={
          panel.upcoming.length > SHOWN.upcoming ? (
            <Link className={SECTION_ACTION} to="/app/reminders">
              View all
            </Link>
          ) : null
        }
        count={panel.upcoming.length}
        items={panel.upcoming.slice(0, SHOWN.upcoming)}
        zone={zone}
      />
      <ComingUp
        action={
          panel.done.length > SHOWN.done ? (
            <Link className={SECTION_ACTION} hash="completed" to="/app/tasks">
              View all
            </Link>
          ) : null
        }
        ahead={false}
        count={panel.done.length}
        icon={CheckCircleIcon}
        items={panel.done.slice(0, SHOWN.done)}
        title="Completed"
        zone={zone}
      />
      <NextSteps>
        {panel.suggestions.map((suggestion) => (
          <Suggested key={suggestion.kind} suggestion={suggestion} />
        ))}
      </NextSteps>
    </>
  )

  return (
    <Tabs onValueChange={(value: Tab) => setTab(value)} value={shown}>
      {/* Reaches up over the scroller's 1rem padding, so nothing scrolls through the gap above it. */}
      <TabsList
        className="sticky -top-4 z-10 -mt-4 bg-popover pt-4"
        ref={tabList}
      >
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
      <TabsContent
        className="gap-4"
        keepMounted
        ref={activityTab}
        value="activity"
      >
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
            host={host}
            live={live}
            thumbnail={thumbnail}
            url={workspace.url}
          />
        </TabsContent>
      ) : null}
    </Tabs>
  )
}

/** The panel in one line, for its header and its minimised state. */
export function WorkspacePanelLine({
  panel,
  avatar,
}: {
  panel: Panel | null
  avatar: AvatarId | null
}) {
  return (
    <LiveLine
      {...(panel?.line ?? { tone: "idle", lead: "This panel did not load" })}
      avatar={avatar}
      lines={panel?.lines}
    />
  )
}

/**
 * Where opening the floating panel moves focus: the review or question
 * waiting on the owner, so the pill opens on what it asks.
 */
export function firstAsk(panel: Panel | null) {
  if (panel?.review) return anchorOf.approval(panel.review.id)
  const [ask] = panel?.waiting ?? []
  return ask?.kind === "approval" || ask?.kind === "question"
    ? anchorOf[ask.kind](ask.id)
    : undefined
}

/** The floating panel's way back to the chat. */
export function ChatLink({ id }: { id: string }) {
  return (
    <Link className={cn(NEXT_STEP, "grow")} params={{ id }} to="/app/c/$id">
      <ChatCircleTextIcon aria-hidden />
      Go to conversation
    </Link>
  )
}

/**
 * The assistant at the bottom right of a page with nothing under way, its
 * face alone: a tap opens the chat.
 */
export function IdleAssistant({
  id,
  avatar,
  name,
}: {
  id: string
  avatar: AvatarId | null
  name: string
}) {
  return (
    <Hint label={`Chat with ${name}`} side="left">
      <Link
        className="flex size-11 items-center justify-center rounded-full border border-border bg-popover shadow-lg outline-none transition-transform duration-150 hover:scale-105 focus-visible:ring-3 focus-visible:ring-ring motion-reduce:transition-none"
        params={{ id }}
        to="/app/c/$id"
      >
        <AssistantAvatar className="size-6" id={avatar} sway />
        <span className="sr-only">Chat with {name}</span>
      </Link>
    </Hint>
  )
}

/**
 * Says the panel's line to a screen reader when what it says changes on the
 * same page: a build starting, a version ready, a question. Not on a
 * navigation, where the line changes because the page did, and not on a
 * build's next stage, which its segment says while the panel is open.
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
