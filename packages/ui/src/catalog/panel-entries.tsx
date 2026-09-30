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
import type { AnswerSpec } from "@workspace/ui/lib/answer"
import type { ReactNode } from "react"

/**
 * Catalog entries for the live panel. Every state a component has is its own
 * entry, and the states the contract defines are enumerated from it: every
 * `AssignmentState` on the stepper, every `FactValueKey` as a question.
 * Brightclean and everything about it is invented; the screenshots are
 * drawn here, not taken of any site.
 */

type Entry = { name: string; render: () => ReactNode }

const noop = () => undefined
/** A change the catalog takes at once. */
const taken = async () => true
const STARTED = "2026-10-01T09:00:00.000Z"
/** Four minutes ten seconds in, pinned so the snapshot does not tick. */
const NOW = Date.parse(STARTED) + 250_000
const TYPICAL = { min: 115, max: 313 }
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
    version={4}
    {...extra}
  />
)

const working = (state: AssignmentState, extra = {}) => (
  <WorkingOn
    build={{
      goal: "Lead the hero with end of tenancy cleans",
      state,
      version: null,
      startedAt: STARTED,
    }}
    now={NOW}
    onStop={noop}
    typical={TYPICAL}
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
  byAssistant: boolean
}
const NOTES: Record<"owner" | "assistant" | "undated", Note> = {
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
            version: 4,
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
            { id: "a", text: "Your review of version 4 closes", at: EXPIRES },
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
          onRequestChanges={taken}
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
      lead="Building version 4,"
      tone="working"
    />
  )
}

const panelCatalog: Entry[] = [
  { name: "WorkingOn", render: () => working("implementing") },
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
        {FactValueKey.options.map((key) => (
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
          { id: "a", text: "Your review of version 4 closes", at: EXPIRES },
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
    name: "ReminderNote set by Reme",
    render: () => reminderNote(NOTES.assistant),
  },
  { name: "ReminderNote undated", render: () => reminderNote(NOTES.undated) },
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
        lead="Version 4 is ready"
        tone="live"
      />
    ),
  },
  {
    name: "LiveLine live",
    render: () => (
      <LiveLine detail="on version 3" lead="Your website is live" tone="live" />
    ),
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
          "You have a reminder today at 15:00: Call the supplier about eco sprays.",
          "Version 4 of your website is ready for you to review below.",
          "Your website is live on version 3.",
        ]}
      />
    ),
  },
  {
    name: "PanelDigest caught up",
    render: () => (
      <PanelDigest
        sentences={[
          "You're all caught up. Nothing needs you right now.",
          "Your website is live on version 3.",
          "Ask Reme in the chat to change something on your website, or to set a reminder.",
        ]}
      />
    ),
  },
  {
    name: "YourWebsite",
    render: () => (
      <YourWebsite
        host="brightclean-demo.example.invalid"
        live={3}
        onRequestChanges={taken}
        thumbnail={THUMBNAIL}
      />
    ),
  },
  {
    name: "YourWebsite request changes",
    render: () => (
      <YourWebsite
        defaultAsking
        host="brightclean-demo.example.invalid"
        live={3}
        onRequestChanges={taken}
        thumbnail={THUMBNAIL}
      />
    ),
  },
  {
    name: "YourWebsite change refused",
    render: () => (
      <YourWebsite
        defaultAsking
        error="That did not go through. Try again."
        host="brightclean-demo.example.invalid"
        live={3}
        onRequestChanges={taken}
        thumbnail={THUMBNAIL}
      />
    ),
  },
  {
    name: "YourWebsite change sent",
    render: () => (
      <YourWebsite
        host="brightclean-demo.example.invalid"
        live={3}
        onRequestChanges={taken}
        status="Sent. Reme is on it; a new version comes to you for review."
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
      <YourWebsite host={null} live={null} onRequestChanges={taken} />
    ),
  },
  {
    name: "PanelBlank",
    render: () => (
      <PanelBlank
        action={nextStep("#getting-started", "Continue getting started")}
        description="Reme builds your website from what you tell it about your business. Share the details below in the chat to get started."
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
    name: "PanelBlank ready to build",
    render: () => (
      <PanelBlank
        action={nextStep("#new-chat", "Start your website")}
        description="Reme builds your website from a conversation with you. Ask for it in the chat, and you review every version before it goes live."
        steps={[{ label: "Build your first version", done: false }]}
      />
    ),
  },
]

export { panelCatalog, SamplePanel, SamplePanelLine }
