import {
  type ApprovalTarget,
  AssignmentState,
  FactValueKey,
} from "@workspace/contracts"
import { buttonVariants } from "@workspace/ui/components/button"
import {
  AddReminder,
  ApprovalItem,
  ComingUp,
  PanelBlank,
  QuestionItem,
  ReminderNote,
  type ReminderRow,
  Reminders,
  WaitingOnYou,
  WorkingOn,
  YourWebsite,
} from "@workspace/ui/components/live-panel"
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
 * One row per derived rule, in the words `apps/web/src/lib/reminders.ts`
 * writes. The first two point at items in the sample panel.
 */
const REMINDERS = {
  review: {
    id: "review",
    text: "Review version 4 before it closes",
    href: "#approval-sample",
  },
  question: {
    id: "question",
    text: "Answer the question about weekday hours",
    detail: "Waiting on you since 1 Oct 2026, 09:00",
    href: "#question-sample",
  },
  preview: { id: "preview", text: "Version 3 is ready but not published" },
  facts: {
    id: "facts",
    text: "Tell Reme your phone number and weekday hours",
  },
} satisfies Record<string, ReminderRow>

/**
 * Reminders written down, one of each kind: the owner's with a time, the
 * Chief of Staff's, and one with no time. `due` is as `apps/web` formats it
 * in the reader's zone.
 */
type Note = { title: string; due: string | null; byAssistant: boolean }
const NOTES: Record<"owner" | "assistant" | "undated", Note> = {
  owner: {
    title: "Call the supplier about eco sprays",
    due: "2 Oct 2026, 14:00",
    byAssistant: false,
  },
  assistant: {
    title: "Send the Hartley Road quote",
    due: "3 Oct 2026, 09:30",
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

/** The add form; a submit is added after a moment, and the form clears. */
const addForm = (extra = {}) => (
  <AddReminder
    onAdd={() => new Promise((done) => setTimeout(() => done(true), 400))}
    {...extra}
  />
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
    <>
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
      <Reminders
        action={addForm()}
        items={[REMINDERS.review, REMINDERS.question]}
      >
        <ReminderNote key="owner" onDone={noop} {...NOTES.owner} />
        <ReminderNote key="assistant" onDone={noop} {...NOTES.assistant} />
      </Reminders>
      <YourWebsite
        host="brightclean-demo.example.invalid"
        live={3}
        thumbnail={THUMBNAIL}
      />
    </>
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
        error:
          "A newer version replaced that one. Check the latest before you decide.",
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
    name: "WaitingOnYou empty",
    render: () => (
      <WaitingOnYou action={nextStep("#notifications", "See notifications")} />
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
    name: "Reminders",
    render: () => (
      <Reminders action={addForm()} items={Object.values(REMINDERS)}>
        {Object.entries(NOTES).map(([key, note]) => (
          <ReminderNote key={key} onDone={noop} {...note} />
        ))}
      </Reminders>
    ),
  },
  {
    name: "Reminders review",
    render: () => <Reminders items={[REMINDERS.review]} />,
  },
  {
    name: "Reminders question",
    render: () => <Reminders items={[REMINDERS.question]} />,
  },
  {
    name: "Reminders preview",
    render: () => <Reminders items={[REMINDERS.preview]} />,
  },
  {
    name: "Reminders facts",
    render: () => <Reminders items={[REMINDERS.facts]} />,
  },
  {
    // Nothing to remember: the section still shows, with the form as its
    // next step.
    name: "Reminders empty",
    render: () => <Reminders action={addForm()} items={[]} />,
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
  { name: "AddReminder", render: () => addForm() },
  {
    name: "AddReminder submitting",
    render: () => addForm({ pending: true }),
  },
  {
    name: "AddReminder refused",
    render: () => addForm({ error: "That time has already passed." }),
  },
  {
    // Added: the form is empty again, the reminder is in the list, and the
    // section says so.
    name: "AddReminder succeeded",
    render: () => (
      <Reminders
        action={addForm()}
        items={[]}
        status="Added to your reminders."
      >
        <ReminderNote key="added" onDone={noop} {...NOTES.undated} />
      </Reminders>
    ),
  },
  {
    name: "YourWebsite",
    render: () => (
      <YourWebsite
        host="brightclean-demo.example.invalid"
        live={3}
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
    render: () => <YourWebsite host={null} live={null} />,
  },
  {
    name: "PanelBlank",
    render: () => (
      <PanelBlank
        action={nextStep("#getting-started", "Continue getting started")}
        description="Tell Reme about your business in the chat, then ask it to build your website."
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
        description="Ask Reme in the chat to build your website."
        steps={[{ label: "Build your first version", done: false }]}
      />
    ),
  },
]

export { panelCatalog, SamplePanel }
