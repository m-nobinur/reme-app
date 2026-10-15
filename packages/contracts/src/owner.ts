import { z } from "zod"
import {
  ApprovalDecision,
  ApprovalRequest,
  AssignmentState,
  InformationRequest,
} from "./assignment.ts"
import { Timestamp, Ulid, Uuid } from "./common.ts"
import { Blueprint, DirectionId, FontPairId } from "./design.ts"
import { FactRecord } from "./fact.ts"
import { choiceFacts } from "./onboarding.ts"
import { SiteLink } from "./site.ts"
import { Text } from "./text.ts"

/**
 * The longest goal a build takes, in characters. The orchestrator refuses a
 * longer one and an owner's change request is capped at it, so both read
 * this one number.
 */
export const GOAL_MAX = 4000

/**
 * The identity `apps/api` sends over the ORCHESTRATOR binding to `OwnerApi`.
 * Only the orchestrator's `OwnerApi` entrypoint reads them, and only a
 * service binding reaches it; the public default export ignores them.
 */
export const OWNER_BRIDGE_HEADERS = {
  orgId: "x-reme-org-id",
  workosUserId: "x-reme-workos-user-id",
  sessionId: "x-reme-session-id",
} as const

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

/**
 * A customer's review the site may quote: their words, unedited; their name
 * as they agreed it may be shown, such as "Marta L."; and the owner's word
 * that the customer agreed to be quoted, which must be true. Stored only
 * through the CoS's `record_review`, after the owner says yes on its card.
 */
export const ReviewValue = z.strictObject({
  quote: Text(500),
  name: Text(80),
  permission: z.literal(true),
})
const fact = <K extends string, V extends z.ZodRawShape>(
  key: K,
  value: V,
  refine: (
    v: z.ZodObject<V, z.core.$strict>
  ) => z.ZodObject<V, z.core.$strict> = (v) => v
) =>
  z.strictObject({ key: z.literal(key), value: refine(z.strictObject(value)) })

/**
 * The value an owner can state for a fact, by key: what the starter site
 * requires (`required: true` in its site config) plus what onboarding learns
 * about the business, the assistant and the site the owner wants. The shapes
 * are the golden fixtures'. The keys are `FactValue.options`; there is no
 * second list.
 *
 * Hours close after they open, on the same day, and a close of `00:00` is
 * midnight at the end of it. `HH:MM` compares as text. The order is checked
 * only once both times parse, so a bad time gets one issue, its own. The
 * published JSON Schema cannot say this, since it cannot compare two fields.
 */
export const FactValue = z.discriminatedUnion("key", [
  fact("business.name", { name: Text(120) }),
  fact("business.phone", { e164: z.string().regex(/^\+[1-9]\d{6,14}$/) }),
  fact("business.email", { address: z.email().max(254) }),
  fact("hours.weekday", { open: HHMM, close: HHMM }, (v) =>
    v.refine((h) => h.close === "00:00" || h.open < h.close, {
      path: ["close"],
      message: "close must be later than open on the same day",
      when: (payload) => payload.issues.length === 0,
    })
  ),
  fact("service_area.radius", {
    centre: Text(80),
    radius_km: z.number().positive().max(200),
  }),
  fact("business.tagline", { tagline: Text(120) }),
  fact("business.industry", choiceFacts.industry),
  fact("business.offerings", { items: z.array(Text(120)).min(1).max(12) }),
  fact("business.audience", { text: Text(500) }),
  fact("business.overview", { text: Text(800) }),
  /**
   * What sets the business apart, in the owner's words: years trading,
   * accreditations, insurance, guarantees, awards, reviews they can quote.
   * The site states only what this holds.
   */
  fact("business.proof", { text: Text(600) }),
  /**
   * The notice a regulated profession must carry, as the owner words it:
   * "Authorised and regulated by ... Registration no. ...". The only source
   * for the footer's disclaimer; with no fact the site states none.
   */
  fact("business.disclaimer", { text: Text(400) }),
  fact("service_area.text", { text: Text(200) }),
  fact("assistant.name", { name: Text(40) }),
  fact("assistant.pronouns", choiceFacts.pronouns),
  fact("assistant.tone", choiceFacts.tone),
  fact("owner.preferred_name", { name: Text(60) }),
  fact("site.build_mode", choiceFacts.buildMode),
  fact("site.template", choiceFacts.template),
  fact("site.palette", choiceFacts.palette, (v) =>
    v.refine(
      (p) =>
        p.id === "custom"
          ? p.custom !== undefined || p.brand !== undefined
          : p.custom === undefined && p.brand === undefined,
      "a preset stands alone; custom needs the owner's words or a brand colour"
    )
  ),
  // A preset face, a pair id from the design tray, or `custom` with the owner's words.
  fact("site.font", {
    ...choiceFacts.font,
    id: z.union([choiceFacts.font.id, FontPairId]),
  }),
  /**
   * The page arrangement from the design tray: a direction id, `custom` with
   * the owner's words in `custom`, or `builder` when the owner left the
   * design to the builder. Neither `custom` nor `builder` is a direction.
   */
  fact("site.direction", { id: DirectionId, custom: Text(200).optional() }),
  fact("site.pages", choiceFacts.pages),
  fact("media.uploads", choiceFacts.uploads),
  fact("quote.form", choiceFacts.quoteForm),
  /** One per review the starter can show; the claims gate quotes nothing else. */
  fact("testimonials.review_1", ReviewValue.shape),
  fact("testimonials.review_2", ReviewValue.shape),
])

export type FactValueKey = FactValue["key"]
export const FactValueKey = z.enum(
  FactValue.options.map((o) => o.shape.key.value) as [
    FactValueKey,
    ...FactValueKey[],
  ]
)

/**
 * The facts onboarding fills from a list of presets or an upload rather than
 * a form, so `ask_fact` never asks for them: `ask_choice` and `ask_upload` do.
 */
export const CHOICE_FACT_KEYS = [
  "business.industry",
  "assistant.pronouns",
  "assistant.tone",
  "site.build_mode",
  "site.template",
  "site.palette",
  "site.font",
  "site.direction",
  "site.pages",
  "media.uploads",
  "quote.form",
] as const satisfies readonly FactValueKey[]
export type ChoiceFactKey = (typeof CHOICE_FACT_KEYS)[number]

/**
 * The reviews, by the slot `record_review` names. Never asked for on a form
 * and never stated by the onboarding planner: a review is stored only with
 * the owner's word that the customer agreed to be quoted.
 */
export const REVIEW_FACT_KEYS = [
  "testimonials.review_1",
  "testimonials.review_2",
] as const satisfies readonly FactValueKey[]
export type ReviewFactKey = (typeof REVIEW_FACT_KEYS)[number]

/** The keys an owner types an answer for, which the web gives inputs to. */
export type AskableFactKey = Exclude<
  FactValueKey,
  ChoiceFactKey | ReviewFactKey
>

/** The longest text answer an owner can give, in characters. */
export const ANSWER_TEXT_MAX = 500

/** An owner's answer to a question whose field is not a FactValue key (open item 70). */
export const OwnerAnswerText = Text(ANSWER_TEXT_MAX)

/**
 * The `answer_schema` the Developer may send for a field that is not a
 * `FactValueKey`. No `pattern`, since a model-written regex is a ReDoS risk
 * on a Worker, and no `enum`, since `options` is the closed list.
 *
 * It is read as zod, never compiled as JSON Schema at runtime (ajv needs
 * `new Function`, which workerd blocks). The answer check is always
 * `OwnerAnswerText`, so non-blank and at most `ANSWER_TEXT_MAX` characters;
 * `maxLength` only narrows that cap, and a missing one never lifts it.
 * `format: "email"` adds `FactValue`'s `business.email` rule (an email
 * address of at most 254 characters). A schema that does not parse as this
 * one leaves the check at `OwnerAnswerText` alone.
 */
export const TextAnswerSchema = z.strictObject({
  type: z.literal("string"),
  maxLength: z.int().min(1).max(ANSWER_TEXT_MAX).optional(),
  format: z.literal("email").optional(),
})

/** `POST /facts`. Distinct keys are `apps/api`'s check, not the schema's. */
export const SetFactsRequest = z.strictObject({
  facts: z.array(FactValue).min(1).max(FactValue.options.length),
})

/** `GET /facts`: the org's current facts. */
export const FactList = z.strictObject({ facts: z.array(FactRecord) })

/**
 * How big a change is, which picks the lane it runs in. The Chief of Staff
 * fills it in the `request_change` call it already makes, so each kind's
 * sentence below is the field's description in the tool schema, where the
 * model reads it. Missing reads as `creative`: an old client, or a model
 * that skips the field, takes the full build.
 */
export const ChangeKind = z.enum([
  "copy",
  "style",
  "section",
  "photo",
  "creative",
])

/** `POST /changes`: what the owner asked for, in their words. */
export const OwnerChangeRequest = z.strictObject({
  text: Text(GOAL_MAX),
  change_kind: ChangeKind.optional().describe(
    "How big the change is. copy: words only, such as a headline, a phone number or a button label. style: colours, fonts or spacing across the site. section: add, remove or rework one section or page. photo: replace, add or remove a picture. creative: a new look, new pages or anything unclear. Omit it when unsure."
  ),
})

/**
 * An answer to an `InformationRequest`. The orchestrator, which knows the
 * request's field, checks `value`: against `FactValue` when the field is a
 * `FactValueKey`; otherwise against the request's `TextAnswerSchema` and its
 * `options`, or as `OwnerAnswerText` when the schema predates that rule.
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

/** A signed preview of one revision: the page, and its three screenshots. */
export const PreviewLink = z.strictObject({
  revision_id: Uuid,
  url: SiteLink,
  screenshots: z.array(SiteLink).length(3),
  expires_at: Timestamp,
})

const RevisionRef = z.strictObject({
  revision_id: Uuid,
  version: z.int().positive(),
})

/**
 * The lane a build runs in: the full pipeline, or the quick edit lane for a
 * small change. Orthogonal to `AssignmentState`, which both lanes share.
 */
export const BuildLane = z.enum(["full", "quick"])

/**
 * One row of a build's progress, such as "Writing the pages, 3 of 5". The
 * orchestrator writes `label` from fixed strings and counts `done` and
 * `total` from the build's own events, so no model ever writes one.
 */
export const BuildActivity = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]{1,29}$/),
  label: Text(60),
  done: z.int().nonnegative().max(999),
  total: z.int().positive().max(999),
  /** What the row counts, by name, such as the plan's pages: fixed labels, never model text. */
  items: z
    .array(z.strictObject({ label: Text(60), done: z.boolean() }))
    .max(9)
    .optional(),
})

/** A generated photo's asset id, the hash-made UUID its object key starts with. */
const PHOTO_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

/** The path the api serves a generated photo at: `GET /photos/{asset id}`. */
export const PHOTO_PATH = new RegExp(`^/photos/(${PHOTO_ID})$`)

/**
 * A generated photo as the app shows it: the app's own door to the api's
 * `GET /photos/{asset id}`, which reads `generated/{org}/{asset id}.{ext}`
 * for the caller's org only. A pattern rather than any URL, so the wire never
 * points an image anywhere else.
 */
export const PhotoThumbnail = z
  .string()
  .regex(new RegExp(`^/api/photos/${PHOTO_ID}$`))

/** The thumbnail of a generated photo by its asset id, or null when there is no id to show. */
export const thumbnailOf = (assetId: string | null | undefined) =>
  assetId && new RegExp(`^${PHOTO_ID}$`).test(assetId)
    ? `/api/photos/${assetId}`
    : null

/**
 * One generated photo of a build while it is made: `drawing` until its slot
 * settles, then `made` with its thumbnail, or `fallback` when no model drew it
 * and its section uses its text layout. `alt` is the plan's, null once a
 * fallback's slot has left the plan.
 */
export const BuildPhoto = z.strictObject({
  slot_id: z.string().min(1),
  state: z.enum(["drawing", "made", "fallback"]),
  alt: z.string().max(200).nullable(),
  thumbnail: PhotoThumbnail.nullable(),
})

/** The most progress rows a build shows at once. */
export const BUILD_ACTIVITY_MAX = 5

/**
 * The plan a build was given (ADR-038), for the Blueprint card. `round`
 * counts plans within the build: a "Change something" re-plans and adds one.
 * `previous` is the plan this one changed, a re-plan's last round or, for a
 * creative change, the plan the live site was built from; the card marks the
 * rows that differ. `awaiting` says the build waits on the owner's "Build it"
 * or "Change something" for this round.
 */
export const BuildBlueprint = z.strictObject({
  plan: Blueprint,
  round: z.int().positive(),
  previous: Blueprint.nullable(),
  awaiting: z.boolean(),
})

/**
 * One owner build, as the workspace panel shows it. `lane` and `activity`
 * are optional while producers catch up: a build with no `lane` is `full`,
 * and one with no `activity` shows only its state.
 */
export const BuildSummary = z.strictObject({
  assignment_id: Uuid,
  kind: z.enum(["site.build", "site.revise"]),
  state: AssignmentState,
  goal: z.string().min(1).max(GOAL_MAX),
  /** The lane it runs in now: a quick edit that fell through reads `full`. */
  lane: BuildLane.optional(),
  /** A quick edit that could not be made quickly and moved to a fuller lane; the panel says so once. */
  fell_through: z.boolean().optional(),
  activity: z.array(BuildActivity).max(BUILD_ACTIVITY_MAX).optional(),
  revision: RevisionRef.nullable(),
  /** Absent on a build that did not plan: a revise, the quick lane, an older row. */
  blueprint: BuildBlueprint.optional(),
  /** The photos this build makes, in the order they settle; absent before its photo step starts. */
  photos: z.array(BuildPhoto).max(24).optional(),
  /** Milliseconds spent waiting on the owner's decided Blueprint reviews, which the panel's clock leaves out. */
  review_ms: z.int().nonnegative().optional(),
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
    /** The generated photos of this version, so the review can badge them (IG4). Absent when none. */
    photos: z
      .array(
        z.strictObject({
          slot_id: z.string().min(1),
          section: z.string().min(1),
          alt: z.string(),
          /** Absent when the file is not known, as on an older event. */
          thumbnail: PhotoThumbnail.optional(),
        })
      )
      .max(24)
      .optional(),
  }),
  ReportItem,
  AlertItem,
])

/** `GET /activity`: reports and alerts from the last 30 days. */
export const ActivityFeed = z.strictObject({
  items: z.array(z.discriminatedUnion("kind", [ReportItem, AlertItem])).max(50),
})

/**
 * A reminder someone wrote down: the owner through `POST /reminders`, or the
 * Chief of Staff through `create_reminder`. The route sets `source`, so it is
 * never on a request. `conversation_id` is the conversation an assistant
 * reminder came from, and null for the owner's own.
 */
export const Reminder = z.strictObject({
  id: Uuid,
  /**
   * The owner's text, or the CoS's restatement of it. If it ever reaches a
   * prompt, it goes in as quoted data, never as instructions.
   */
  title: Text(200),
  due_at: Timestamp.nullable(),
  done_at: Timestamp.nullable(),
  source: z.enum(["owner", "assistant"]),
  conversation_id: Uuid.nullable(),
  created_at: Timestamp,
  updated_at: Timestamp,
})

/**
 * `POST /reminders`, and the `create_reminder` tool's input. `due_at` is
 * required and nullable rather than optional, because a provider's strict
 * tool mode wants every property named in `required`.
 */
export const CreateReminderRequest = z.strictObject({
  title: Reminder.shape.title,
  due_at: Timestamp.nullable(),
})

/** `PATCH /reminders/:id`: complete a reminder, or reopen it. */
export const ReminderPatch = z.strictObject({ done: z.boolean() })

/**
 * A reminder the api derives from a row that waits on the owner. It carries
 * facts, never copy: the UI writes the words. It has no id and no done state
 * of its own, because it clears when the row it points at resolves.
 *
 * - `approval_expiring`: a review within 24 hours of its expiry.
 * - `question_waiting`: a question open for more than 12 hours.
 * - `preview_unpublished`: a build's preview that was never published.
 * - `facts_missing`: the required facts still to ask for, as `missing_facts`.
 */
export const DerivedReminder = z.discriminatedUnion("rule", [
  z.strictObject({
    rule: z.literal("approval_expiring"),
    approval_id: Uuid,
    version: z.int().positive(),
    expires_at: Timestamp,
  }),
  z.strictObject({ rule: z.literal("question_waiting"), request_id: Uuid }),
  z.strictObject({
    rule: z.literal("preview_unpublished"),
    assignment_id: Uuid,
    version: z.int().positive(),
  }),
  z.strictObject({
    rule: z.literal("facts_missing"),
    keys: z.array(FactValueKey).min(1),
  }),
])

/** The most open reminders `/workspace` lists. */
export const REMINDER_NOTES_MAX = 20

/** `GET /workspace`: everything the owner's panel polls for. */
export const WorkspaceStatus = z.strictObject({
  site: z.strictObject({
    host: z.string().min(1).nullable(),
    /** Where `host` opens, built by `siteUrl`: http and a port on local dev. Null with `host`. */
    url: SiteLink.nullable(),
    /**
     * The version being served, and the build that made it, so the panel can
     * read its screenshots through `GET /builds/:id/preview`.
     */
    live: RevisionRef.extend({ assignment_id: Uuid }).nullable(),
  }),
  /** Non-terminal, newest first. */
  builds: z.array(BuildSummary).max(10),
  /**
   * How long each lane usually takes, in seconds from the last measurement,
   * so the panel's "usually takes" copy is data. `p50` is not above `p95`;
   * the producer keeps that, since a JSON Schema cannot compare two fields.
   * Absent until the api sends it, and the panel keeps its own range.
   */
  expected_seconds: z
    .strictObject({
      full: z.strictObject({
        p50: z.int().positive(),
        p95: z.int().positive(),
      }),
      quick: z.strictObject({
        p50: z.int().positive(),
        p95: z.int().positive(),
      }),
    })
    .optional(),
  /** Approvals by expiry, then questions, alerts, reports. */
  attention: z.array(AttentionItem),
  /** The required facts still to ask for. */
  missing_facts: z.array(FactValueKey),
  /** The name the owner gave their assistant, or null before they chose one. */
  assistant_name: Text(40).nullable(),
  reminders: z.strictObject({
    /** Open ones only: soonest due first, undated after, then newest first. */
    notes: z.array(Reminder).max(REMINDER_NOTES_MAX),
    derived: z.array(DerivedReminder),
  }),
})

export type FactValue = z.infer<typeof FactValue>
export type SetFactsRequest = z.infer<typeof SetFactsRequest>
export type FactList = z.infer<typeof FactList>
export type ChangeKind = z.infer<typeof ChangeKind>
export type OwnerChangeRequest = z.infer<typeof OwnerChangeRequest>
export type BuildLane = z.infer<typeof BuildLane>
export type BuildActivity = z.infer<typeof BuildActivity>
export type BuildPhoto = z.infer<typeof BuildPhoto>
export type AnswerRequest = z.infer<typeof AnswerRequest>
export type DecisionRequest = z.infer<typeof DecisionRequest>
export type PreviewLink = z.infer<typeof PreviewLink>
export type BuildSummary = z.infer<typeof BuildSummary>
export type BuildBlueprint = z.infer<typeof BuildBlueprint>
export type AttentionItem = z.infer<typeof AttentionItem>
export type ActivityFeed = z.infer<typeof ActivityFeed>
export type Reminder = z.infer<typeof Reminder>
export type CreateReminderRequest = z.infer<typeof CreateReminderRequest>
export type ReminderPatch = z.infer<typeof ReminderPatch>
export type DerivedReminder = z.infer<typeof DerivedReminder>
export type WorkspaceStatus = z.infer<typeof WorkspaceStatus>
