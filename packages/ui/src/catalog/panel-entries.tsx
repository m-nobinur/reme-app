import { ArrowSquareOutIcon } from "@phosphor-icons/react"
import {
  type ApprovalTarget,
  AssignmentState,
  FactValueKey,
} from "@workspace/contracts"
import { buttonVariants } from "@workspace/ui/components/button"
import {
  ApprovalItem,
  ComingUp,
  LiveLine,
  NextSteps,
  PanelBlank,
  PanelDigest,
  QuestionItem,
  ReminderList,
  ReminderNote,
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
import { type AnswerSpec, askable } from "@workspace/ui/lib/answer"
import { paletteStops } from "@workspace/ui/lib/blueprint"
import type { ReactNode } from "react"
import { BLUEPRINT } from "./blueprint-fixtures"

/**
 * Catalog entries for the live panel. Every state a component has is its own
 * entry, and the states the contract defines are enumerated from it: every
 * `AssignmentState` on the stepper, every `FactValueKey` as a question.
 * Brightclean and everything about it is invented; the screenshots are
 * drawn here, not taken of any site.
 */

type Entry = { name: string; render: () => ReactNode }

const noop = () => undefined
const STARTED = "2026-10-01T09:00:00.000Z"
/** Four minutes ten seconds in, pinned so the snapshot does not tick. */
const NOW = Date.parse(STARTED) + 250_000
const NOW_ISO = new Date(NOW).toISOString()
const EXPECTED = { p50: 180, p95: 330 }
const EXPIRES = "2026-10-04T09:00:00.000Z"
const REVISION: ApprovalTarget = {
  kind: "revision",
  revision_id: "2f41c9ab-0000-4000-8000-000000000005",
}

/**
 * A drawn page: a header band, a heading, three lines. No real site. Grey
 * by opacity alone, over the image's own token background.
 */
const page = (width: number) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width * 1.4}" viewBox="0 0 30 42"><rect width="30" height="6" fill-opacity=".45"/><rect x="3" y="10" width="18" height="3" fill-opacity=".7"/><rect x="3" y="16" width="24" height="1.5" fill-opacity=".3"/><rect x="3" y="19" width="22" height="1.5" fill-opacity=".3"/><rect x="3" y="22" width="16" height="1.5" fill-opacity=".3"/></svg>`
  )}`

const PREVIEW = {
  url: "https://preview.example.invalid/",
  screenshots: [page(390), page(768), page(1440)],
}

/** A blank section's next step, as `apps/web` draws its links. */
const nextStep = (href: string, label: string) => (
  <a
    className={`${buttonVariants({ variant: "outline", size: "sm" })} self-start`}
    href={href}
  >
    {label}
  </a>
)

/** A next step as `apps/web` draws it: an outline button, link or not. */
const STEP = buttonVariants({ variant: "outline", size: "sm" })

/** A live site's next steps, as the panel offers them on Home. */
const liveSteps = (
  <NextSteps>
    <button className={STEP} key="change" type="button">
      Request a change
    </button>
    <a
      className={STEP}
      href="#visit"
      key="visit"
      title="brightclean-demo.example.invalid"
    >
      Visit your website
      <span className="sr-only"> (opens in a new tab)</span>
      <ArrowSquareOutIcon aria-hidden className="text-muted-foreground" />
    </a>
  </NextSteps>
)

/** A read that takes a moment, so the retry's pending state shows. */
const retry = () => new Promise<void>((done) => setTimeout(done, 400))

/** The live site's home page on a laptop, as the panel's thumbnail. */
const THUMBNAIL = { src: page(1440) }

const ANSWER_EXPIRY = "The build waits on you until you answer."
const APPROVAL_EXPIRY =
  "Nothing is published without you. If it expires, the build waits until you decide."

const question = (spec: AnswerSpec, title: string, extra = {}) => (
  <QuestionItem
    askedBy="Alex"
    expiresAt={null}
    onAnswer={noop}
    onExpiry={ANSWER_EXPIRY}
    spec={spec}
    title={title}
    why="The contact section shows when you are open."
    {...extra}
  />
)

const approval = (extra = {}) => (
  <ApprovalItem
    expiresAt={EXPIRES}
    onApprove={noop}
    onAskForChanges={noop}
    onExpiry={APPROVAL_EXPIRY}
    preview={PREVIEW}
    rationale="The hero now leads with end of tenancy cleans."
    target={REVISION}
    {...extra}
  />
)

/**
 * A drawn room in one palette's own colours, standing in for a generated
 * photo whatever the app's theme. Nothing real.
 */
const scene = (id: "mint" | "sage" | "pebble") => {
  const [paper, tint, primary, ink] = paletteStops({ kind: "preset", id })
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90" viewBox="0 0 120 90"><rect width="120" height="90" fill="${tint}"/><rect x="14" y="12" width="34" height="30" fill="${paper}"/><rect y="62" width="120" height="28" fill="${ink}" fill-opacity=".55"/><rect x="66" y="44" width="38" height="20" rx="3" fill="${primary}"/><circle cx="24" cy="56" r="7" fill="${primary}" fill-opacity=".7"/></svg>`
  )}`
}

/** The fixture plan with a gallery and a contact page, so the pages count to six. */
const PLAN = {
  ...BLUEPRINT,
  pages: [
    ...BLUEPRINT.pages,
    ...(["gallery", "contact"] as const).map((id) => ({
      page: id,
      sections: BLUEPRINT.pages[0]?.sections.slice(0, 2) ?? [],
    })),
  ],
}

const row = (id: string, label: string, done: number, total = 1) => ({
  id,
  label,
  done,
  total,
})

/** The plan's six pages as the writing step names them, the first `done` written. */
const pages = (done: number) =>
  ["Home", "Services", "About", "Request a quote", "Gallery", "Contact"].map(
    (label, i) => ({ label, done: i < done })
  )

/** A full build's steps as the api lists them, at `step` with these counts. */
const steps = (
  at: "planning" | "photos" | "writing" | "design" | "fixing" | "checking",
  counts: { photos?: number; pages?: number } = {}
) => {
  const order = [
    "planning",
    "photos",
    "writing",
    "design",
    "fixing",
    "checking",
  ]
  const passed = (id: string) => order.indexOf(id) < order.indexOf(at)
  const whole = (id: string, label: string) =>
    row(id, label, passed(id) ? 1 : 0)
  return [
    whole("planning", "Planning the layout"),
    row(
      "photos",
      "Making photos",
      passed("photos") ? 4 : (counts.photos ?? 0),
      4
    ),
    {
      ...row(
        "writing",
        "Writing the pages",
        passed("writing") ? 6 : (counts.pages ?? 0),
        6
      ),
      items: pages(passed("writing") ? 6 : (counts.pages ?? 0)),
    },
    whole("design", "Looking over the design"),
    // The gates sent it back once: the row stays, before the checks it comes back to.
    ...(at === "fixing"
      ? [whole("fixing", "Fixing what the checks found")]
      : []),
    whole("checking", "Checking the site"),
  ]
}

const PHOTOS = {
  hero: scene("mint"),
  kitchen: scene("sage"),
  bath: scene("pebble"),
}

const photo = (
  slot_id: string,
  state: "drawing" | "made" | "fallback",
  thumbnail: string | null = null,
  alt: string | null = "A bright room after a clean"
) => ({ slot_id, state, alt, thumbnail })

/** A full build of the fixture plan, at `state`, with its steps, at the panel's width. */
const building = (
  state: AssignmentState,
  activity: ReturnType<typeof steps>,
  extra: Record<string, unknown> = {}
) => (
  <div className="max-w-[22rem]">
    {working(state, {
      build: {
        goal: "Build my website from the details I gave you",
        state,
        startedAt: STARTED,
        lane: "full",
        activity,
        plan: PLAN,
        ...extra,
      },
    })}
  </div>
)

const working = (state: AssignmentState, extra = {}) => (
  <WorkingOn
    build={{
      goal: "Lead the hero with end of tenancy cleans",
      state,
      startedAt: STARTED,
    }}
    now={NOW}
    onStop={noop}
    expectedSeconds={EXPECTED}
    {...extra}
  />
)

/**
 * Reminders written down, one of each kind: the owner's due within the hour,
 * the Chief of Staff's, and one with no time. `due` is as `apps/web` formats
 * it in the reader's zone.
 */
type Note = {
  title: string
  due: string | null
  soon?: boolean
  overdue?: boolean
  byAssistant: boolean
}
const NOTES: Record<"owner" | "assistant" | "undated" | "overdue", Note> = {
  owner: {
    title: "Call the supplier about eco sprays",
    due: "Today, 2:00 pm",
    soon: true,
    byAssistant: false,
  },
  assistant: {
    title: "Send the Hartley Road quote",
    due: "Sat 3 Oct, 9:30 am",
    byAssistant: true,
  },
  undated: {
    title: "Order more microfibre cloths",
    due: null,
    byAssistant: false,
  },
  overdue: {
    title: "Restock the van with mop heads",
    due: "Mon 28 Sep, 9:00 am",
    overdue: true,
    byAssistant: false,
  },
}

const reminderNote = (props: Note, extra = {}) => (
  <ReminderNote onDone={noop} {...props} {...extra} />
)

/** A panel item a reminder can point at, as `apps/web` wraps them. */
const target = (id: string, item: ReactNode) => (
  <div
    className="rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring"
    id={id}
    tabIndex={-1}
  >
    {item}
  </div>
)

/** The panel as a workspace shows it mid-build, for the shell's own entry. */
function SamplePanel() {
  return (
    <Tabs defaultValue="activity">
      <TabsList>
        <TabsTrigger value="activity">Activity</TabsTrigger>
        <TabsTrigger value="reminders">
          Reminders
          <span className="text-muted-foreground tabular-nums">2</span>
        </TabsTrigger>
        <TabsTrigger value="website">Website</TabsTrigger>
      </TabsList>
      <TabsContent keepMounted value="activity">
        {working("validating", {
          build: {
            goal: "Lead the hero with end of tenancy cleans",
            state: "validating",
            startedAt: STARTED,
          },
          queued: ["Add Saturday hours to the contact section"],
        })}
        <WaitingOnYou>
          {target(
            "question-sample",
            question({ kind: "fact", key: "hours.weekday" }, "Weekday hours")
          )}
          {target("approval-sample", approval())}
        </WaitingOnYou>
        <ComingUp
          items={[
            {
              id: "a",
              text: "Your review of the new version closes",
              at: EXPIRES,
            },
          ]}
        />
      </TabsContent>
      <TabsContent value="reminders">
        <ReminderList>
          <ReminderNote key="owner" onDone={noop} {...NOTES.owner} />
          <ReminderNote key="assistant" onDone={noop} {...NOTES.assistant} />
        </ReminderList>
      </TabsContent>
      <TabsContent value="website">
        <YourWebsite
          host="brightclean-demo.example.invalid"
          live={3}
          onRequestChanges={noop}
          thumbnail={THUMBNAIL}
        />
      </TabsContent>
    </Tabs>
  )
}

/** `SamplePanel` in one line, as `apps/web` words it for that state. */
function SamplePanelLine() {
  return (
    <LiveLine
      detail="checking the site"
      lead="Building a new version,"
      tone="working"
    />
  )
}

const panelCatalog: Entry[] = [
  { name: "NextSteps", render: () => liveSteps },
  {
    name: "NextSteps getting started",
    render: () => (
      <NextSteps>
        <a className={STEP} href="#getting-started" key="continue">
          Continue getting started
        </a>
      </NextSteps>
    ),
  },
  {
    name: "NextSteps on the reminders page",
    render: () => (
      <NextSteps>
        <a className={STEP} href="#remind" key="remind">
          Set a reminder
        </a>
      </NextSteps>
    ),
  },
  {
    // The Activity tab on Home with nothing waiting: where things stand,
    // what went live today, and what to do next.
    name: "Panel caught up",
    render: () => (
      <div className="flex max-w-88 flex-col gap-6">
        <PanelDigest sentences={["All caught up. Your website is live."]} />
        <ComingUp
          items={[{ id: "v3", text: "Published v3", at: STARTED }]}
          title="Latest"
        />
        {liveSteps}
      </div>
    ),
  },
  {
    // The Activity tab while a new business gets started.
    name: "Panel getting started",
    render: () => (
      <div className="flex max-w-88 flex-col gap-6">
        <PanelDigest
          sentences={[
            "Getting Brightclean ready for its first website.",
            "2 details to go before your assistant can build it.",
          ]}
        />
        <PanelBlank
          steps={[
            { label: "Phone number", done: false },
            { label: "Weekday hours", done: false },
            { label: "Build your first version", done: false },
          ]}
        />
        <NextSteps>
          <a className={STEP} href="#getting-started" key="continue">
            Continue getting started
          </a>
        </NextSteps>
      </div>
    ),
  },
  {
    // A chat while a build runs: what Ellie is doing, then the stepper.
    name: "Panel in a chat while building",
    render: () => (
      <div className="flex max-w-88 flex-col gap-6">
        <PanelDigest
          sentences={[
            "Ellie is building a new version while you chat.",
            "Keep chatting. Nothing goes live until you approve it.",
          ]}
        />
        {working("validating", {
          build: {
            goal: "Lead the hero with end of tenancy cleans",
            state: "validating",
            startedAt: STARTED,
          },
        })}
      </div>
    ),
  },
  {
    name: "ComingUp latest",
    render: () => (
      <ComingUp
        items={[
          { id: "fail", text: "A build failed", at: NOW_ISO },
          { id: "v3", text: "Published v3", at: STARTED },
        ]}
        title="Latest"
      />
    ),
  },
  { name: "WorkingOn", render: () => working("implementing") },
  {
    name: "WorkingOn with activity",
    render: () =>
      working("implementing", {
        build: {
          goal: "Lead the hero with end of tenancy cleans",
          state: "implementing",
          startedAt: STARTED,
          lane: "full",
          activity: [
            { id: "planning", label: "Planning the layout", done: 1, total: 1 },
            { id: "writing", label: "Writing the pages", done: 3, total: 5 },
            { id: "photos", label: "Making photos", done: 0, total: 7 },
          ],
        },
      }),
  },
  // A full build's steps as it moves, from planning to ready.
  {
    // No plan yet: nothing decided to show, so no photo or design step.
    name: "WorkingOn planning",
    render: () =>
      building(
        "planning",
        [
          row("planning", "Planning the layout", 0),
          row("writing", "Writing the pages", 0),
          row("checking", "Checking the site", 0),
        ],
        { plan: undefined }
      ),
  },
  {
    name: "WorkingOn review wait",
    render: () =>
      building("planning", steps("planning"), { awaitingReview: true }),
  },
  {
    name: "WorkingOn photos",
    render: () =>
      building("implementing", steps("photos", { photos: 2 }), {
        reviewMs: 95_000,
        photos: [
          photo("slot_1", "made", PHOTOS.hero),
          photo("slot_3", "made", PHOTOS.kitchen),
          photo("slot_4", "drawing"),
          photo("slot_5", "drawing"),
        ],
      }),
  },
  {
    name: "WorkingOn pages",
    render: () =>
      building("implementing", steps("writing", { pages: 3 }), {
        reviewMs: 95_000,
        photos: [
          photo("slot_1", "made", PHOTOS.hero),
          photo("slot_3", "made", PHOTOS.kitchen),
          photo("slot_4", "made", PHOTOS.bath),
          photo("slot_5", "fallback", null, null),
        ],
      }),
  },
  {
    name: "WorkingOn design look",
    render: () =>
      building("implementing", steps("design"), {
        reviewMs: 95_000,
        photos: [
          photo("slot_1", "made", PHOTOS.hero),
          photo("slot_3", "made", PHOTOS.kitchen),
          photo("slot_4", "made", PHOTOS.bath),
          photo("slot_5", "made", PHOTOS.hero),
        ],
      }),
  },
  {
    name: "WorkingOn repair",
    render: () =>
      building("implementing", steps("fixing"), {
        reviewMs: 95_000,
        photos: [
          photo("slot_1", "made", PHOTOS.hero),
          photo("slot_3", "made", PHOTOS.kitchen),
          photo("slot_4", "made", PHOTOS.bath),
          photo("slot_5", "made", PHOTOS.hero),
        ],
      }),
  },
  {
    name: "WorkingOn checking",
    render: () =>
      building("validating", steps("checking"), {
        reviewMs: 95_000,
        photos: [
          photo("slot_1", "made", PHOTOS.hero),
          photo("slot_3", "made", PHOTOS.kitchen),
          photo("slot_4", "made", PHOTOS.bath),
          photo("slot_5", "made", PHOTOS.hero),
        ],
      }),
  },
  {
    // Ready: the api lists no steps, and the clock stopped when it got ready.
    name: "WorkingOn ready",
    render: () =>
      building("awaiting_review", [], {
        reviewMs: 95_000,
        endedAt: new Date(Date.parse(STARTED) + 400_000).toISOString(),
      }),
  },
  {
    name: "WorkingOn quick lane",
    render: () =>
      working("revising", {
        build: {
          goal: "Change the hero title",
          state: "revising",
          startedAt: STARTED,
          lane: "quick",
        },
        expectedSeconds: { p50: 15, p95: 45 },
      }),
  },
  {
    name: "WorkingOn with a queue",
    render: () =>
      working("queued", {
        queued: ["Add Saturday hours", "Change the phone number"],
      }),
  },
  {
    name: "WorkingOn confirming",
    render: () => working("implementing", { defaultConfirming: true }),
  },
  {
    name: "WorkingOn stopping",
    render: () => working("implementing", { stopping: true }),
  },
  {
    name: "WorkingOn error",
    render: () =>
      working("implementing", {
        error: "That did not stop the build. Try again.",
      }),
  },
  {
    name: "WorkingOn states",
    render: () => (
      <div className="grid gap-6 sm:grid-cols-2">
        {AssignmentState.options.map((state) => (
          <div key={state}>{working(state)}</div>
        ))}
      </div>
    ),
  },
  {
    name: "QuestionItem",
    render: () =>
      question({ kind: "fact", key: "hours.weekday" }, "Weekday hours"),
  },
  {
    name: "QuestionItem kinds",
    render: () => (
      <div className="grid gap-4 sm:grid-cols-2">
        {FactValueKey.options.filter(askable).map((key) => (
          <div key={key}>{question({ kind: "fact", key }, key)}</div>
        ))}
        {question({ kind: "text", maxLength: 80, email: false }, "Parking")}
        {question({ kind: "text", maxLength: 254, email: true }, "Bookings")}
        {question(
          { kind: "choice", options: ["Weekly", "Fortnightly", "Monthly"] },
          "Visit frequency"
        )}
      </div>
    ),
  },
  {
    name: "QuestionItem pending",
    render: () =>
      question({ kind: "fact", key: "business.phone" }, "Phone number", {
        pending: true,
      }),
  },
  {
    name: "QuestionItem error",
    render: () =>
      question({ kind: "fact", key: "business.email" }, "Email address", {
        error:
          "That answer does not fit the question. Check it and send it again.",
      }),
  },
  { name: "ApprovalItem", render: () => approval() },
  {
    name: "ApprovalItem loading",
    render: () => approval({ preview: "loading" }),
  },
  {
    name: "ApprovalItem pending",
    render: () => approval({ pending: "approve" }),
  },
  {
    name: "ApprovalItem asking",
    render: () => approval({ defaultAsking: true }),
  },
  {
    name: "ApprovalItem change pending",
    render: () => approval({ pending: "change" }),
  },
  {
    name: "ApprovalItem error",
    render: () =>
      approval({
        preview: "error",
        onRetryPreview: retry,
        error:
          "A newer version replaced that one. Check the latest before you decide.",
      }),
  },
  // The preview could not be read: say so, offer a retry, and still let
  // the owner decide.
  {
    name: "ApprovalItem preview unavailable",
    render: () => approval({ preview: "error", onRetryPreview: retry }),
  },
  // Generated photos badged in the review: the hero from the laptop shot, the
  // other a tile until it has a thumbnail of its own.
  {
    name: "ApprovalItem with generated photos",
    render: () =>
      approval({
        photoActions: { onRemove: noop, onTryAnother: noop, onUseOwn: noop },
        photos: [
          {
            alt: "A bright kitchen after a clean",
            section: "hero",
            slot_id: "hero",
          },
          { alt: "The team at work", section: "about", slot_id: "about" },
        ],
      }),
  },
  // The preview was read but its screenshots do not load: the link stays.
  {
    name: "ApprovalItem screenshots failed",
    render: () =>
      approval({
        preview: {
          url: PREVIEW.url,
          screenshots: [
            "/no-such-shot.png",
            "/no-such-shot.png",
            "/no-such-shot.png",
          ],
        },
      }),
  },
  {
    name: "ApprovalItem unbound",
    render: () =>
      approval({
        target: { kind: "domain", hostname: "brightclean.example.invalid" },
      }),
  },
  {
    name: "WaitingOnYou",
    render: () => (
      <WaitingOnYou status="Published v3.">
        {question({ kind: "fact", key: "business.phone" }, "Phone number")}
      </WaitingOnYou>
    ),
  },
  {
    name: "WaitingOnYou error",
    render: () => (
      <WaitingOnYou error="This panel did not load." onRetry={retry} />
    ),
  },
  {
    name: "ComingUp",
    render: () => (
      <ComingUp
        items={[
          {
            id: "a",
            text: "Your review of the new version closes",
            at: EXPIRES,
          },
          {
            id: "b",
            text: "The question about weekday hours closes",
            at: "2026-10-05T09:00:00.000Z",
          },
        ]}
      />
    ),
  },
  {
    name: "ReminderList",
    render: () => (
      <ReminderList>
        {Object.entries(NOTES).map(([key, note]) => (
          <ReminderNote key={key} onDone={noop} {...note} />
        ))}
      </ReminderList>
    ),
  },
  {
    name: "ReminderList marked done",
    render: () => (
      <ReminderList status="Marked done.">
        <ReminderNote key="assistant" onDone={noop} {...NOTES.assistant} />
      </ReminderList>
    ),
  },
  { name: "ReminderNote", render: () => reminderNote(NOTES.owner) },
  {
    name: "ReminderNote set by the assistant",
    render: () => reminderNote(NOTES.assistant),
  },
  { name: "ReminderNote undated", render: () => reminderNote(NOTES.undated) },
  { name: "ReminderNote overdue", render: () => reminderNote(NOTES.overdue) },
  {
    name: "ReminderNote pending",
    render: () => reminderNote(NOTES.owner, { pending: true }),
  },
  {
    name: "ReminderNote failed",
    render: () =>
      reminderNote(NOTES.owner, {
        error: "That did not go through. Try again.",
      }),
  },
  { name: "LiveLine", render: () => <SamplePanelLine /> },
  // The panel's own tabs are the tabs' sample: Activity, Reminders, Website.
  { name: "Tabs", render: () => <SamplePanel /> },
  { name: "TabsList", render: () => <SamplePanel /> },
  { name: "TabsTrigger", render: () => <SamplePanel /> },
  { name: "TabsContent", render: () => <SamplePanel /> },
  {
    name: "LiveLine waiting",
    render: () => (
      <LiveLine
        detail="for your review"
        lead="A new version is ready"
        tone="live"
      />
    ),
  },
  {
    // Minimised at 390, the step fraction stays in view as the words truncate.
    name: "LiveLine building",
    render: () => (
      <div className="w-64">
        <LiveLine
          detail="writing the pages"
          lead="Building your first version,"
          progress={{ done: 3, total: 5 }}
          tone="working"
        />
      </div>
    ),
  },
  {
    name: "LiveLine live",
    render: () => <LiveLine lead="Your website is live" tone="live" />,
  },
  {
    name: "LiveLine idle",
    render: () => (
      <LiveLine lead="Let's get your website started" tone="idle" />
    ),
  },
  {
    // A long name truncates; the line never wraps.
    name: "LiveLine truncated",
    render: () => (
      <div className="w-64">
        <LiveLine
          detail="has a question for you"
          lead="Brightclean End of Tenancy and Carpet Specialists"
          tone="live"
        />
      </div>
    ),
  },
  {
    name: "PanelDigest",
    render: () => (
      <PanelDigest
        sentences={[
          "Ellie is updating your website.",
          "A new version is ready to review.",
        ]}
      />
    ),
  },
  {
    name: "PanelDigest caught up",
    render: () => (
      <PanelDigest sentences={["All caught up. Your website is live."]} />
    ),
  },
  {
    name: "YourWebsite",
    render: () => (
      <YourWebsite
        host="brightclean-demo.example.invalid"
        live={3}
        onRequestChanges={noop}
        thumbnail={THUMBNAIL}
      />
    ),
  },
  {
    name: "YourWebsite with its plan",
    render: () => (
      <YourWebsite
        blueprint={BLUEPRINT}
        host="brightclean-demo.example.invalid"
        live={3}
        onRequestChanges={noop}
        thumbnail={THUMBNAIL}
      />
    ),
  },
  {
    name: "YourWebsite loading",
    render: () => (
      <YourWebsite
        host="brightclean-demo.example.invalid"
        live={3}
        thumbnail="loading"
      />
    ),
  },
  {
    // An image that does not decode: the section falls back to its text.
    name: "YourWebsite screenshot failed",
    render: () => (
      <YourWebsite
        host="brightclean-demo.example.invalid"
        live={3}
        thumbnail={{ src: "data:image/png;base64," }}
      />
    ),
  },
  {
    name: "YourWebsite unpublished",
    render: () => (
      <YourWebsite host={null} live={null} onRequestChanges={noop} />
    ),
  },
  {
    name: "PanelBlank",
    render: () => (
      <PanelBlank
        action={nextStep("#getting-started", "Continue getting started")}
        description="Ellie builds your website from what you tell her about your business. Share the details below in the chat to get started."
        steps={[
          { label: "Business name", done: true },
          { label: "Phone number", done: false },
          { label: "Weekday hours", done: false },
          { label: "Build your first version", done: false },
        ]}
      />
    ),
  },
  {
    // Under a headline that already says what to do: the steps alone.
    name: "PanelBlank steps only",
    render: () => (
      <PanelBlank
        steps={[
          { label: "Weekday hours", done: false },
          { label: "Build your first version", done: false },
        ]}
      />
    ),
  },
  {
    name: "PanelBlank ready to build",
    render: () => (
      <PanelBlank
        action={nextStep("#new-chat", "Start your website")}
        description="Ellie builds your website from a conversation with you. Ask for it in the chat, and you review every version before it goes live."
        steps={[{ label: "Build your first version", done: false }]}
      />
    ),
  },
]

export { panelCatalog, SamplePanel, SamplePanelLine }
