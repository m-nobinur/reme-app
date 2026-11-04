import type { Journey, OwnerTask } from "@workspace/contracts"
import { addressStage } from "./tasks.ts"

// The website journey: one reading of the records for the update stack, the
// draft-ready line and the assistant's per-turn notes, so all three say the
// same. Pure: the callers read the rows, this decides. The model never sees
// this state, only the lines `notes.ts` renders from it.

/** A sitting ends after this long with no owner message, or with a new conversation. */
export const SITTING_GAP_MS = 30 * 60_000

/** Bring-backs of an open question in the sitting its card was shown in; any later sitting gets one. */
export const BRING_BACKS = 2

/** The address card as a turn reads it (`cardState`), with when it was shown. */
export type JourneyCard = {
  answer: "yes" | "no" | "later" | null
  /** The question it still shows, only when it sits in this turn's conversation. */
  waiting: "have" | "name" | null
  shown_at: string
}

/** The owner's earlier messages, for the sitting and what changed while they were away. */
export type OwnerVisit = {
  /** This turn's conversation. */
  conversation: string
  /** The owner's earlier messages across the org, newest first. */
  recent: readonly { at: string; conversation: string }[]
}

/**
 * A latch is written in the turn's transaction, before the owner's message
 * that starts a sitting is stored, so it may read a moment older than it.
 */
const LATCH_SLACK_MS = 60_000

/** A journey ledger row (`deliveries`, key without its org prefix). */
export type Latch = { key: string; at: string }

export type JourneyInput = {
  tasks: readonly OwnerTask[]
  website: {
    live: boolean
    building: boolean
    /** Drafts waiting on the owner: their review's id and when it opened. */
    drafts: readonly { id: string; at: string }[]
  }
  card?: JourneyCard | null
  /** Set only for a turn the owner typed. */
  visit?: OwnerVisit | null
  latches?: readonly Latch[]
  now?: Date
}

/** Something that happened while the owner was away, told once. */
export type JourneyChange = {
  key: string
  kind: "draft_ready" | "bought" | "live" | "google_connected"
  at: string
  name?: string
}

export type JourneyState = Journey & {
  address: Journey["address"] & { until?: string }
  /** The card on screen in this conversation, if any, settled once the stage moved past it. */
  waiting: JourneyCard["waiting"]
  sitting: { fresh: boolean; away_ms: number | null; since: string } | null
  /** Untold changes since the owner's last message, on a fresh sitting only. */
  changes: JourneyChange[]
  /** Bring the open address back this turn: after an aside while its card waits, or on a return. */
  bring_back: "aside" | "return" | null
  /** Ledger keys to record when this turn's note says them. */
  record: string[]
}

const OFFERS: Partial<
  Record<Journey["address"]["stage"], Journey["address"]["offer"]>
> = {
  none: "connect",
  unknown: "connect",
  choosing: "connect",
  buying_elsewhere: "connect",
  bought: "connect_bought",
}

function googleOf(
  tasks: readonly OwnerTask[],
  own: boolean,
  now: Date
): Journey["google"] {
  const task = tasks.find((t) => t.kind === "google")
  if (task?.state === "done") return "connected"
  if (task?.state === "declined") return "declined"
  if (task?.state === "active") return "setting_up"
  if (
    task?.state === "later" &&
    task.later_until &&
    Date.parse(task.later_until) > now.getTime()
  )
    return "put_off"
  return own ? "offerable" : "waiting_for_domain"
}

function sittingOf(visit: OwnerVisit, now: Date): JourneyState["sitting"] {
  const [last] = visit.recent
  const gap = (later: number, at: string) =>
    later - Date.parse(at) >= SITTING_GAP_MS
  const fresh =
    !last ||
    last.conversation !== visit.conversation ||
    gap(now.getTime(), last.at)
  let since = fresh ? now.toISOString() : (last?.at as string)
  if (!fresh) {
    for (const [i, m] of visit.recent.entries()) {
      const next = visit.recent[i + 1]
      if (!next || next.conversation !== m.conversation) break
      if (gap(Date.parse(m.at), next.at)) break
      since = next.at
    }
  }
  return {
    fresh,
    away_ms: last ? now.getTime() - Date.parse(last.at) : null,
    since,
  }
}

function changesOf(
  input: JourneyInput,
  since: string,
  told: ReadonlySet<string>
): JourneyChange[] {
  const after = (at: string | null | undefined): at is string =>
    !!at && at > since
  const found: JourneyChange[] = input.website.drafts.flatMap((d) =>
    after(d.at)
      ? [{ key: `draft:${d.id}`, kind: "draft_ready" as const, at: d.at }]
      : []
  )
  for (const task of input.tasks) {
    if (task.kind === "address") {
      const name = task.detail.name
      const purchase = task.steps.find((s) => s.step === "purchase")
      if (
        task.detail.origin === "buying_elsewhere" &&
        purchase?.state === "done" &&
        after(purchase.changed_at)
      )
        found.push({
          key: `bought:${task.id}`,
          kind: "bought",
          at: purchase.changed_at,
          ...(name && { name }),
        })
      if (task.state === "done" && after(task.done_at))
        found.push({
          key: `live:${task.id}`,
          kind: "live",
          at: task.done_at,
          ...(name && { name }),
        })
    } else if (task.state === "done" && after(task.done_at)) {
      found.push({
        key: `google:${task.id}`,
        kind: "google_connected",
        at: task.done_at,
      })
    }
  }
  return found
    .filter((c) => !told.has(`told:${c.key}`))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
}

/**
 * The journey from the records: the website's stage, the address's stage and
 * the Connect it offers, Google's stage; and for a turn the owner typed, the
 * card still on screen, the sitting, what changed while they were away and
 * whether the open address may be brought back now. Events and how they move
 * it: the card shown sets `waiting`; answered on the card or in words moves
 * the address stage, which settles the card; the owner writing instead is an
 * aside; skipped is `put_off` (the stack and the heartbeat's follow-up only);
 * "no, I don't want one" is `declined` (never again); buying elsewhere, the
 * registry showing it bought, DNS live, a draft ready and Google connected or
 * declined each move a stage and, while the owner was away, become a change
 * told once on their return.
 */
export function journeyOf(input: JourneyInput): JourneyState {
  const now = input.now ?? new Date()
  const { stage, name, until } = addressStage(input.tasks)
  const { website: site, card = null, visit = null, latches = [] } = input
  const website: Journey["website"] = site.live
    ? "published"
    : site.drafts.length > 0
      ? "draft_ready"
      : site.building
        ? "building"
        : "none"
  const offer = OFFERS[stage] ?? null
  const open = stage === "none" || stage === "unknown"
  const waiting =
    card?.waiting === "have" && open
      ? "have"
      : card?.waiting === "name" && stage === "unknown"
        ? "name"
        : null
  const sitting = visit ? sittingOf(visit, now) : null
  const told = new Set(latches.map((l) => l.key))
  const last = visit?.recent[0]?.at
  const changes = sitting?.fresh && last ? changesOf(input, last, told) : []
  const brought = sitting
    ? latches.filter(
        (l) =>
          l.key.startsWith("bring_back:") &&
          Date.parse(l.at) >= Date.parse(sitting.since) - LATCH_SLACK_MS
      ).length
    : 0
  const limit =
    card && sitting && card.shown_at >= sitting.since ? BRING_BACKS : 1
  const due =
    sitting !== null &&
    offer !== null &&
    (card !== null || website !== "none") &&
    brought < limit
  const bring_back = !due
    ? null
    : waiting
      ? "aside"
      : sitting.fresh
        ? "return"
        : null
  return {
    website,
    address: { stage, ...(name && { name }), offer, ...(until && { until }) },
    google: googleOf(
      input.tasks,
      stage === "connecting" || stage === "live",
      now
    ),
    waiting,
    sitting,
    changes,
    bring_back,
    record: [
      ...(bring_back ? [`bring_back:${now.toISOString()}`] : []),
      ...changes.map((c) => `told:${c.key}`),
    ],
  }
}
