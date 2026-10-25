import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  PulseIcon,
} from "@phosphor-icons/react"
import type {
  ActivitySegment,
  ApprovalTarget,
  BuildActivity,
} from "@workspace/contracts"
import { buttonVariants } from "@workspace/ui/components/button"
import {
  ApprovalItem,
  ComingUp,
  LiveLine,
  NextSteps,
  PanelSegment,
  QuestionItem,
  ReminderList,
  ReminderNote,
  SECTION_ACTION,
  StageDetail,
  StopBuild,
  WaitingOnYou,
  YourWebsite,
} from "@workspace/ui/components/live-panel"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@workspace/ui/components/tabs"
import {
  segmentKind,
  segmentLine,
  segmentTitle,
  stepKind,
  stepLabel,
} from "@workspace/ui/lib/activity-copy"
import { paletteStops } from "@workspace/ui/lib/blueprint"
import type { ReactNode } from "react"
import { BLUEPRINT } from "./blueprint-fixtures"

/**
 * Catalog entries for the live panel. Every state a component has is its own
 * entry. Segments are worded by the copy table, as `apps/web` words them.
 * Brightclean and everything about it is invented; the screenshots are
 * drawn here, not taken of any site.
 */

type Entry = { name: string; render: () => ReactNode }

const noop = () => undefined
const STARTED = "2026-10-01T09:00:00.000Z"
/** Four minutes ten seconds in. */
const NOW_ISO = new Date(Date.parse(STARTED) + 250_000).toISOString()
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

const PREVIEW = { url: "https://preview.example.invalid/" }

/** The site's mark as the starter draws it: its initial in a rounded square, grey by opacity alone. */
export const ICON = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill-opacity=".25"/><text x="16" y="22" font-family="sans-serif" font-size="17" font-weight="600" fill-opacity=".8" text-anchor="middle">B</text></svg>`
)}`

/** A version's pictures: the drawn page on a laptop, twice, and on a phone, and its icon. */
const PICTURES = {
  laptop: page(1440),
  "laptop-2": page(1440),
  phone: page(390),
  icon: ICON,
}

/** A next step as `apps/web` draws it: an outline button, link or not. */
const STEP = buttonVariants({ variant: "outline", size: "sm" })

/** A live site's next step, as the panel offers it on Home. */
const liveSteps = (
  <NextSteps>
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

const question = (title: string) => (
  <QuestionItem
    action={
      <button
        className={buttonVariants({ variant: "outline", size: "sm" })}
        type="button"
      >
        Answer in the chat
      </button>
    }
    title={title}
  />
)

const approval = (extra = {}) => (
  <ApprovalItem
    onApprove={noop}
    pictures={PICTURES}
    preview={PREVIEW}
    target={REVISION}
    title="Brightclean"
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

const row = (
  id: string,
  label: string,
  done: number,
  total = 1
): BuildActivity => ({ id, label, done, total })

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

const CTX = { orgId: "brightclean", assistant: "Ellie" }

/** A step as the api sends it. */
const stepAt = (
  id: string,
  state: ActivitySegment["steps"][number]["state"],
  extra: Partial<ActivitySegment["steps"][number]> = {}
) => ({ id, state, ...extra })

/** The fixed steps of a kind, `here` the one at work and the rest after it. */
const along = (
  ids: readonly string[],
  here: number,
  state: "now" | "waiting" = "now"
) =>
  ids.map((id, i) =>
    stepAt(id, i < here ? "done" : i === here ? state : "next")
  )

const WEBSITE = [
  "planning",
  "photos",
  "writing",
  "polishing",
  "checking",
  "ready",
]

/** A segment as `apps/web` draws it, worded by the copy table, at the panel's width. */
const segment = (
  s: Omit<ActivitySegment, "at"> & { at?: string },
  extra: {
    children?: ReactNode
    details?: Record<string, ReactNode>
  } = {}
) => {
  const full: ActivitySegment = { at: STARTED, ...s }
  return (
    <div className="max-w-[22rem]">
      <PanelSegment
        icon={segmentKind(full)}
        line={segmentLine(full, CTX, { elapsedSeconds: 250, until: "11:50" })}
        state={full.state}
        steps={full.steps.flatMap((step) => {
          const label = stepLabel(full, step)
          return label
            ? [
                {
                  id: step.id,
                  label,
                  state: step.state,
                  kind: stepKind(full, step),
                  detail: extra.details?.[step.id],
                },
              ]
            : []
        })}
        title={segmentTitle(full, CTX) ?? ""}
        working={segmentTitle({ ...full, state: "now" }, CTX) ?? ""}
      >
        {extra.children}
      </PanelSegment>
    </div>
  )
}

const BUSINESS = { business: "Brightclean" }

const ONBOARDING_STEPS = (last: "now" | "waiting" | "done") => [
  stepAt("work", "done", { value: "Regular cleans, end of tenancy" }),
  stepAt("area", "done", { value: "South Manchester, 10 miles" }),
  stepAt("customers", "skipped"),
  stepAt("contact", "done", { value: "0161 496 0000, hello@brightclean.test" }),
  stepAt("assistant", "done", { value: "Ellie" }),
  stepAt("quote_form", "done", { value: "6 questions" }),
  stepAt("photos", last === "done" ? "done" : last, {
    ...(last === "done" ? { value: "4 photos" } : {}),
  }),
  stepAt("look", last === "done" ? "done" : "next", {
    ...(last === "done" ? { value: "Mint, Classic" } : {}),
  }),
]

/** The website's stages with what each decided or made, as the panel draws them under the steps. */
const stageDetails = (
  activity: BuildActivity[],
  photos: ReturnType<typeof photo>[] = []
) =>
  Object.fromEntries(
    WEBSITE.map((stage, i) => [
      stage,
      <StageDetail
        activity={activity}
        key={stage}
        photos={photos}
        plan={PLAN}
        stage={stage}
        state={i < 2 ? "done" : "now"}
      />,
    ])
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
      <TabsContent className="gap-4" keepMounted value="activity">
        <WaitingOnYou icon={PulseIcon} limit={3} title="Now">
          {segment({
            id: "change",
            kind: "change",
            state: "now",
            steps: along(["understanding", "making", "checking", "ready"], 2),
          })}
          {target("question-sample", question("Weekday hours"))}
          {target("approval-sample", approval())}
          {target("question-more", question("Phone number"))}
        </WaitingOnYou>
        <ComingUp
          items={[
            {
              id: "a",
              text: "Call the supplier about eco sprays",
              at: EXPIRES,
            },
          ]}
        />
        <ComingUp
          action={
            <a className={SECTION_ACTION} href="#tasks">
              View all
            </a>
          }
          items={[
            { id: "website", text: "Website built", at: STARTED },
            { id: "setup", text: "Brightclean set up", at: STARTED },
          ]}
          ahead={false}
          icon={CheckCircleIcon}
          title="Completed"
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
  return <LiveLine lead="Ellie is updating your website" tone="working" />
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
    // The Activity tab on Home with nothing waiting: what finished, and
    // the site.
    name: "Panel caught up",
    render: () => (
      <div className="flex max-w-88 flex-col gap-6">
        <ComingUp
          action={
            <a className={SECTION_ACTION} href="#tasks">
              View all
            </a>
          }
          items={[
            {
              id: "golive",
              text: "Website published at brightclean-demo.example.invalid",
              at: STARTED,
            },
          ]}
          ahead={false}
          icon={CheckCircleIcon}
          title="Completed"
        />
        {liveSteps}
      </div>
    ),
  },
  {
    // The first run: the website under way in Now, what is coming up, and
    // getting started under Completed.
    name: "Panel first run",
    render: () => (
      <div className="flex max-w-88 flex-col gap-6">
        <WaitingOnYou icon={PulseIcon} title="Now">
          {segment(
            {
              id: "website",
              kind: "website",
              state: "now",
              steps: [
                ...along(WEBSITE, 2).slice(0, 2),
                stepAt("writing", "now", { count: { done: 3, total: 6 } }),
                ...along(WEBSITE, 2).slice(3),
              ],
            },
            {
              details: stageDetails(steps("writing", { pages: 3 })),
              children: <StopBuild onStop={noop} state="implementing" />,
            }
          )}
        </WaitingOnYou>
        <ComingUp
          items={[
            {
              id: "a",
              text: "Call the supplier about eco sprays",
              at: EXPIRES,
            },
            {
              id: "b",
              text: "Send the Hartley Road quote",
              at: "2026-10-05T09:00:00.000Z",
            },
          ]}
        />
        <ComingUp
          action={
            <a className={SECTION_ACTION} href="#tasks">
              View all
            </a>
          }
          items={[{ id: "setup", text: "Brightclean set up", at: STARTED }]}
          ahead={false}
          icon={CheckCircleIcon}
          title="Completed"
        />
      </div>
    ),
  },
  {
    name: "PanelSegment getting started",
    render: () =>
      segment({
        id: "onboarding",
        kind: "onboarding",
        state: "now",
        steps: ONBOARDING_STEPS("now"),
        names: BUSINESS,
      }),
  },
  {
    // The owner's turn: the step pulses and points at the tray.
    name: "PanelSegment getting started waiting",
    render: () =>
      segment({
        id: "onboarding",
        kind: "onboarding",
        state: "waiting",
        steps: ONBOARDING_STEPS("waiting"),
        names: BUSINESS,
      }),
  },
  {
    name: "PanelSegment before a business name",
    render: () =>
      segment({
        id: "onboarding",
        kind: "onboarding",
        state: "now",
        steps: along(
          [
            "work",
            "area",
            "customers",
            "contact",
            "assistant",
            "quote_form",
            "photos",
            "look",
          ],
          0
        ),
      }),
  },
  {
    // Done: one ticked line, no caret, nothing to open.
    name: "PanelSegment done",
    render: () =>
      segment({
        id: "onboarding",
        kind: "onboarding",
        state: "done",
        steps: ONBOARDING_STEPS("done"),
        names: BUSINESS,
      }),
  },
  // A segment, and what each of its stages decided or made.
  ...(
    ["PanelSegment website photos", "PanelSegment", "StageDetail"] as const
  ).map((name) => ({
    name,
    render: () =>
      segment(
        {
          id: "website",
          kind: "website",
          state: "now",
          steps: [
            stepAt("planning", "done"),
            stepAt("photos", "now", { count: { done: 2, total: 4 } }),
            // The steps after photos, still to come.
            ...along(WEBSITE, 1).slice(2),
          ],
        },
        {
          details: stageDetails(steps("photos", { photos: 2 }), [
            photo("slot_1", "made", PHOTOS.hero),
            photo("slot_3", "made", PHOTOS.kitchen),
            photo("slot_4", "drawing"),
            photo("slot_5", "drawing"),
          ]),
          children: <StopBuild onStop={noop} state="implementing" />,
        }
      ),
  })),
  {
    // A stage that does not apply stays in the list, skipped.
    name: "PanelSegment website skipped",
    render: () =>
      segment({
        id: "website",
        kind: "website",
        state: "now",
        steps: [
          stepAt("planning", "done"),
          stepAt("photos", "skipped"),
          stepAt("writing", "done"),
          stepAt("polishing", "skipped"),
          stepAt("checking", "now"),
          stepAt("ready", "next"),
        ],
      }),
  },
  {
    name: "PanelSegment website failed",
    render: () =>
      segment({
        id: "website",
        kind: "website",
        state: "failed",
        steps: along(WEBSITE, 4),
      }),
  },
  {
    // The first version's review is the going-live segment's first step.
    name: "PanelSegment going live",
    render: () =>
      segment(
        {
          id: "golive",
          kind: "golive",
          state: "waiting",
          steps: along(["approval", "publishing", "loads"], 0, "waiting"),
          names: BUSINESS,
        },
        { children: approval() }
      ),
  },
  {
    name: "PanelSegment change",
    render: () =>
      segment({
        id: "change",
        kind: "change",
        state: "now",
        steps: along(["understanding", "making", "checking", "ready"], 1),
      }),
  },
  {
    name: "PanelSegment domain",
    render: () =>
      segment({
        id: "domain",
        kind: "domain",
        state: "waiting",
        steps: along(["dns", "certificate", "loads"], 0, "waiting"),
        names: { domain: "brightclean.example.invalid" },
      }),
  },
  {
    name: "PanelSegment purchase",
    render: () =>
      segment({
        id: "purchase",
        kind: "purchase",
        state: "waiting",
        steps: along(
          ["details", "payment", "registration", "connecting"],
          1,
          "waiting"
        ),
        names: { domain: "brightclean.example.invalid" },
        deadline: EXPIRES,
      }),
  },
  {
    name: "PanelSegment Google",
    render: () =>
      segment({
        id: "google",
        kind: "google",
        state: "now",
        steps: along(["sign_in", "verify", "sitemap"], 1),
      }),
  },
  {
    name: "ComingUp completed",
    render: () => (
      <ComingUp
        items={[
          {
            id: "checkin",
            text: "Ellie checked in, all clear",
            at: NOW_ISO,
          },
          {
            id: "domain",
            text: "Brightclean.example.invalid connected",
            at: STARTED,
          },
        ]}
        ahead={false}
        icon={CheckCircleIcon}
        title="Completed"
      />
    ),
  },
  {
    name: "StopBuild",
    render: () => <StopBuild onStop={noop} state="implementing" />,
  },
  {
    name: "StopBuild confirming",
    render: () => (
      <StopBuild defaultConfirming onStop={noop} state="implementing" />
    ),
  },
  {
    name: "StopBuild stopping",
    render: () => <StopBuild onStop={noop} state="implementing" stopping />,
  },
  {
    name: "StopBuild error",
    render: () => (
      <StopBuild
        error="That did not stop the build. Try again."
        onStop={noop}
        state="implementing"
      />
    ),
  },
  {
    name: "StopBuild quick edit moved on",
    render: () => <StopBuild fellThrough onStop={noop} state="implementing" />,
  },
  { name: "QuestionItem", render: () => question("Weekday hours") },
  { name: "ApprovalItem", render: () => approval() },
  {
    name: "ApprovalItem loading",
    render: () => approval({ preview: "loading", pictures: null }),
  },
  {
    name: "ApprovalItem pending",
    render: () => approval({ pending: true }),
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
  {
    name: "ApprovalItem unbound",
    render: () =>
      approval({
        target: { kind: "domain", hostname: "brightclean.example.invalid" },
      }),
  },
  // The section every panel list sits in.
  ...(["WaitingOnYou", "PanelSection"] as const).map((name) => ({
    name,
    render: () => (
      <WaitingOnYou status="Published v3.">
        {question("Phone number")}
      </WaitingOnYou>
    ),
  })),
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
      <LiveLine detail="are ready to publish" lead="Your changes" tone="live" />
    ),
  },
  {
    name: "LiveLine building",
    render: () => (
      <div className="w-64">
        <LiveLine lead="Ellie is building your website" tone="working" />
      </div>
    ),
  },
  {
    name: "LiveLine several jobs",
    render: () => (
      <div className="w-72">
        <LiveLine
          lead="Ellie is building your website"
          lines={[
            { lead: "Ellie is building your website" },
            { lead: "Ellie is replying to a new enquiry" },
            { lead: "Ellie is drafting a quote" },
            { lead: "Your changes", detail: "are ready to publish" },
          ]}
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
  // The screenshot, and the light it drifts on until it loads.
  ...(["YourWebsite", "Shot", "Diffusing"] as const).map((name) => ({
    name,
    render: () => (
      <YourWebsite
        host="brightclean-demo.example.invalid"
        live={3}
        onRequestChanges={noop}
        thumbnail={THUMBNAIL}
      />
    ),
  })),
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
]

export { panelCatalog, SamplePanel, SamplePanelLine }
