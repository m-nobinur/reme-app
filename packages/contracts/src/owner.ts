import { z } from "zod"
import {
  ApprovalDecision,
  ApprovalRequest,
  AssignmentState,
  InformationRequest,
} from "./assignment.ts"
import { Timestamp, Ulid, Uuid } from "./common.ts"
import { FactRecord } from "./fact.ts"

/**
 * The longest goal a build takes, in characters. The orchestrator refuses a
 * longer one and an owner's change request is capped at it, so both read
 * this one number.
 */
export const GOAL_MAX = 4000

/**
 * The identity `apps/api` sends over the ORCHESTRATOR binding to `OwnerApi`.
 * Only a binding can deliver these; the public default export never reads
 * them (ADR-032 amendment).
 */
export const OWNER_BRIDGE_HEADERS = {
  orgId: "x-reme-org-id",
  workosUserId: "x-reme-workos-user-id",
  sessionId: "x-reme-session-id",
} as const

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
/** Text with something in it. A regex rather than `.trim()`, which the JSON Schema cannot say. */
const Text = (max: number) => z.string().min(1).max(max).regex(/\S/)
const fact = <K extends string, V extends z.ZodRawShape>(key: K, value: V) =>
  z.strictObject({ key: z.literal(key), value: z.strictObject(value) })

/**
 * The value an owner can state for a fact, by key: the six the starter site
 * requires (`required: true` in its site config) plus the tagline. The shapes
 * are the golden fixtures'. Currencies are the ones the content gate can
 * verify. The keys are `FactValue.options`; there is no second list.
 *
 * Open-before-close is not checked: the form's time input sets `min`.
 */
export const FactValue = z.discriminatedUnion("key", [
  fact("business.name", { name: Text(120) }),
  fact("business.phone", { e164: z.string().regex(/^\+[1-9]\d{6,14}$/) }),
  fact("business.email", { address: z.email().max(254) }),
  fact("hours.weekday", { open: HHMM, close: HHMM }),
  fact("service_area.radius", {
    centre: Text(80),
    radius_km: z.number().positive().max(200),
  }),
  fact("pricing.standard_clean_hourly", {
    amount_minor: z.int().positive(),
    currency: z.enum(["GBP", "USD", "EUR"]),
  }),
  fact("business.tagline", { tagline: Text(120) }),
])

export type FactValueKey = FactValue["key"]
export const FactValueKey = z.enum(
  FactValue.options.map((o) => o.shape.key.value) as [
    FactValueKey,
    ...FactValueKey[],
  ]
)

/** An owner's answer to a question whose field is not a FactValue key (open item 70). */
export const OwnerAnswerText = Text(500)

/** `POST /facts`. Distinct keys are `apps/api`'s check, not the schema's. */
export const SetFactsRequest = z.strictObject({
  facts: z.array(FactValue).min(1).max(FactValue.options.length),
})

/** `GET /facts`: the org's current facts. */
export const FactList = z.strictObject({ facts: z.array(FactRecord) })

/** `POST /changes`: what the owner asked for, in their words. */
export const OwnerChangeRequest = z.strictObject({
  text: Text(GOAL_MAX),
})

/**
 * An answer to an `InformationRequest`. `value` is checked against
 * `FactValue` where the request's field is known, which is the orchestrator.
 */
export const AnswerRequest = z.strictObject({
  request_id: Uuid,
  value: z.unknown(),
})

/**
 * `POST /approvals/:id/decision`, bound to the revision the owner was shown.
 * Revision approvals only: `requestReview` is the one producer of approvals.
 */
export const DecisionRequest = z.strictObject({
  decision: ApprovalDecision.shape.decision,
  revision_id: Uuid,
})

/** `meta` carries the protocol rule into the JSON Schema, which `protocol` alone does not. */
const Https = z.url({ protocol: /^https$/ }).meta({ pattern: "^https://" })

/** A signed preview of one revision: the page, and its three screenshots. */
export const PreviewLink = z.strictObject({
  revision_id: Uuid,
  url: Https,
  screenshots: z.array(Https).length(3),
  expires_at: Timestamp,
})

const RevisionRef = z.strictObject({
  revision_id: Uuid,
  version: z.int().positive(),
})

/** One owner build, as the workspace panel shows it. */
export const BuildSummary = z.strictObject({
  assignment_id: Uuid,
  kind: z.enum(["site.build", "site.revise"]),
  state: AssignmentState,
  goal: z.string().min(1).max(GOAL_MAX),
  revision: RevisionRef.nullable(),
  created_at: Timestamp,
  updated_at: Timestamp,
})

const Logged = { event_id: Ulid, assignment_id: Uuid.nullable(), at: Timestamp }

const ReportItem = z.strictObject({
  kind: z.literal("report"),
  ...Logged,
  what: z.enum(["published"]),
  revision: RevisionRef,
})
const AlertItem = z.strictObject({
  kind: z.literal("alert"),
  ...Logged,
  reason: z.enum(["build_failed", "budget_parked", "publish_rolled_back"]),
})

/**
 * §7.3: exactly four kinds. The copy is the UI's; the wire carries facts
 * about the item, so a question and an approval embed the request whole.
 */
export const AttentionItem = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("question"), request: InformationRequest }),
  z.strictObject({
    kind: z.literal("approval"),
    // `/workspace` lists revision approvals only, until another target has a producer.
    request: ApprovalRequest,
    version: z.int().positive(),
  }),
  ReportItem,
  AlertItem,
])

/** `GET /activity`: reports and alerts from the last 30 days. */
export const ActivityFeed = z.strictObject({
  items: z.array(z.discriminatedUnion("kind", [ReportItem, AlertItem])).max(50),
})

/** `GET /workspace`: everything the owner's panel polls for. */
export const WorkspaceStatus = z.strictObject({
  site: z.strictObject({
    host: z.string().min(1).nullable(),
    live: RevisionRef.nullable(),
  }),
  /** Non-terminal, newest first. */
  builds: z.array(BuildSummary).max(10),
  /** Approvals by expiry, then questions, alerts, reports. */
  attention: z.array(AttentionItem),
  /** The required facts still to ask for. */
  missing_facts: z.array(FactValueKey),
})

export type FactValue = z.infer<typeof FactValue>
export type SetFactsRequest = z.infer<typeof SetFactsRequest>
export type FactList = z.infer<typeof FactList>
export type OwnerChangeRequest = z.infer<typeof OwnerChangeRequest>
export type AnswerRequest = z.infer<typeof AnswerRequest>
export type DecisionRequest = z.infer<typeof DecisionRequest>
export type PreviewLink = z.infer<typeof PreviewLink>
export type BuildSummary = z.infer<typeof BuildSummary>
export type AttentionItem = z.infer<typeof AttentionItem>
export type ActivityFeed = z.infer<typeof ActivityFeed>
export type WorkspaceStatus = z.infer<typeof WorkspaceStatus>
