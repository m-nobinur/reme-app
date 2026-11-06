import {
  type ThreadMessage as MessageData,
  useAuiState,
} from "@assistant-ui/react"
import type { ServerButton, ServerMessageKind } from "@workspace/contracts"
import { StateIcon, StatusIcon } from "@workspace/ui/components/status-line"
import type { StatusKind } from "@workspace/ui/lib/activity-copy"
import { formatTime } from "@workspace/ui/lib/format"
import type { StateName } from "@workspace/ui/lib/status-icons"
import { cn } from "@workspace/ui/lib/utils"
import { localMidnight } from "@workspace/ui/lib/zone"
import type { FC } from "react"

/** The day a stored message was written, from the `createdAt` the server puts in `metadata.custom`. */
export const createdAt = (message: MessageData | undefined): string | null => {
  const at = message?.metadata.custom.createdAt
  return typeof at === "string" ? at : null
}

/**
 * A rule with the date, above the first message of each day. A message with
 * no stored date draws none: the runtime's own `createdAt` is the time it was
 * rendered, which would date every old message today.
 */
export const DateDivider: FC = () => {
  // The selectors return the stored strings as they are, so a streaming
  // update to another message costs a comparison, not a date parse.
  const at = useAuiState((s) => createdAt(s.message))
  const before = useAuiState((s) =>
    createdAt(s.thread.messages[s.message.index - 1])
  )
  const day = localDay(at)
  if (day === null || day === localDay(before)) return null
  return (
    <div
      data-slot="aui_date-divider"
      className="flex items-center gap-3 text-[0.8125rem] text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border"
    >
      <time dateTime={at ?? undefined}>{LOCAL_DAY.format(new Date(day))}</time>
    </div>
  )
}

/** The rule above the first message this browser had not shown before. */
export const NewDivider: FC = () => (
  <div
    data-slot="aui_new-divider"
    className="flex items-center gap-3 font-medium text-[0.8125rem] text-primary before:h-px before:flex-1 before:bg-primary/40 after:h-px after:flex-1 after:bg-primary/40"
  >
    <span>
      New<span className="sr-only"> messages</span>
    </span>
  </div>
)

type Action = ServerButton["action"]["kind"]

/** What a posted update is about, as its button's action says. */
const UPDATE_KINDS: Partial<Record<Action, StatusKind>> = {
  connect: "google",
  pay: "payment",
  open: "domain",
}

type Labelled = Exclude<ServerMessageKind, "reply">

/** Each kind of posted message's label and mark; an update's mark may be its button's. */
const MESSAGE_KINDS: Record<Labelled, { label: string; state: StateName }> = {
  update: { label: "Update", state: "notifications" },
  note: { label: "Note", state: "note" },
  done: { label: "Done", state: "done" },
  reminder: { label: "Reminder", state: "reminder" },
}

type Parts = readonly { type: string; name?: string; data?: unknown }[]

/** A message the app posted on its own (a `srv_` id) by its kind; null for any other. */
const postedKind = (message: {
  id: string
  parts: Parts
}): ServerMessageKind | null => {
  if (!message.id.startsWith("srv_")) return null
  const part = message.parts.find((p) => p.type === "data" && p.name === "kind")
  return (part?.data as ServerMessageKind | undefined) ?? "update"
}

/** A posted message that carries a label: every kind but a reply, which reads as any reply. */
export const labelled = (message: { id: string; parts: Parts }) => {
  const kind = postedKind(message)
  return kind === null || kind === "reply" ? null : kind
}

/**
 * Above a message the app posted on its own, other than a reply: its kind's
 * mark (an update's button may give its own) and label, and when it landed,
 * on the device's clock. The newest labelled message in the thread is in the
 * primary colour, its mark ringing as it arrives.
 */
export const UpdateLabel: FC<{ kind: Labelled }> = ({ kind }) => {
  const about = useAuiState((s) => {
    const button = s.message.parts.find(
      (part) => part.type === "data" && part.name === "button"
    )
    const action: Action | undefined =
      button?.type === "data" ? button.data?.action?.kind : undefined
    return (action && UPDATE_KINDS[action]) ?? null
  })
  const at = useAuiState((s) => sentAt(s.message))
  const latest = useAuiState(
    (s) => s.thread.messages.filter(labelled).at(-1)?.id === s.message.id
  )
  const { label, state } = MESSAGE_KINDS[kind]
  const icon = cn(
    "size-3.5",
    latest
      ? "origin-top text-primary motion-safe:animate-update-ring"
      : "text-muted-foreground"
  )
  return (
    <p
      data-slot="aui_update-label"
      className="mb-1 flex items-center gap-1.5 text-[0.8125rem] text-muted-foreground"
    >
      {about && kind === "update" ? (
        <StatusIcon className={icon} kind={about} still />
      ) : (
        <StateIcon className={icon} state={state} />
      )}
      <span className={cn(latest && "font-medium text-primary")}>{label}</span>
      <span aria-hidden>·</span>
      <time className="tabular-nums" dateTime={at}>
        {formatTime(new Date(at))}
      </time>
    </p>
  )
}

/**
 * The owner's own calendar day, not UTC's: a message at 23:30Z in summer is
 * already tomorrow in the UK. The thread renders only in the browser, so the
 * reader's zone is the owner's zone and nothing has to match a server render.
 */
const LOCAL_DAY = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
})

/** Local midnight of the message's day, as a number to compare; null without a date. */
const localDay = (at: string | null): number | null => {
  if (!at) return null
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? null : localMidnight(date)
}

/** When a message was written: the stored date, else the runtime's own for one sent here. */
export const sentAt = (message: MessageData): string =>
  createdAt(message) ?? message.createdAt.toISOString()
