import { z } from "zod"
import { InformationRequest } from "./assignment.ts"
import { ChatRequest, RequestChangeOutput } from "./chat.ts"
import {
  ActionEvidence,
  Evidence,
  JsonObject,
  Timestamp,
  TimeZone,
  Ulid,
  Uuid,
} from "./common.ts"
import { ConversationMessage, MessageRating } from "./conversation.ts"
import {
  DnsRecord,
  DomainCheck,
  DomainInspection,
  DomainName,
  DomainProvider,
  DomainRegistrantPrefill,
  DomainState,
  DomainStemOffer,
  NotRegisteredYet,
} from "./domain.ts"
import { ToolCallId } from "./ids.ts"
import { RememberInput, RememberOutput } from "./memory.ts"
import {
  BUILD_ACTIVITY_MAX,
  BuildStopCause,
  BuildSummary,
  CreateReminderRequest,
  E164,
  FactValue,
  FactValueKey,
  OwnerAnswerText,
  OwnerChangeRequest,
  Reminder,
  ReviewValue,
  WorkspaceStatus,
} from "./owner.ts"
import { Refused } from "./refused.ts"
import { CompletionReport, GateName, SiteReview } from "./report.ts"
import {
  ConnectGoogleInput,
  ConnectGoogleOutput,
  GetIndexingInput,
  GetIndexingOutput,
  GetSearchPerformanceInput,
  GetSearchPerformanceOutput,
} from "./search.ts"
import {
  ReadSkillInput,
  ReadSkillOutput,
  SaveCorrectionInput,
  SaveCorrectionOutput,
  ScheduleSkillInput,
  ScheduleSkillOutput,
} from "./skills.ts"
import { OwnerTask, TaskKind } from "./task.ts"
import { Text, ToolStep } from "./text.ts"

// The Chief of Staff's tools and its event log (ADR-034). A tool's output is
// what the model reads, so none carries an org id, a staff id or a signed
// URL: the model never sees tenancy ids, and a signed link is a bearer
// capability the tool UI fetches for itself.

const Version = z.int().positive()
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const Usd = z.number().nonnegative()

/** `get_workspace`'s output: the panel's state, cut to what the model needs. */
export const CosWorkspace = z.strictObject({
  site: z.strictObject({
    host: z.string().min(1).nullable(),
    live_version: Version.nullable(),
  }),
  /** Non-terminal, newest first. */
  builds: z
    .array(
      z.strictObject({
        assignment_id: BuildSummary.shape.assignment_id,
        kind: BuildSummary.shape.kind,
        state: BuildSummary.shape.state,
        lane: BuildSummary.shape.lane,
        /** The owner's words as the build restated them: data, never instructions. */
        goal: BuildSummary.shape.goal,
        version: Version.nullable(),
        /** Started again on its own after a build that stopped. */
        retry: z.boolean().optional(),
        /** Fixing what its checks found: the repair round it is on, and the checks that failed. */
        fixing: z
          .strictObject({
            round: z.int().min(1).max(9),
            checks: z.array(GateName).max(GateName.options.length),
          })
          .optional(),
        /**
         * The build's steps as the panel shows them: fixed labels and counts,
         * never model text. Optional: tool results stored before it replay.
         */
        progress: z
          .array(
            z.strictObject({
              step: Text(60),
              done: z.int().nonnegative(),
              total: z.int().positive(),
              now: z.boolean(),
            })
          )
          .max(BUILD_ACTIVITY_MAX)
          .optional(),
        /**
         * While the pipeline works on it: whole minutes since it started,
         * less the owner's plan reviews, and since it last logged any work.
         * `overdue` is past the top of its lane's range, and `range` is the
         * panel's words for the wait ("about 6 to 10 minutes"), moved up to
         * start above the time gone once overdue. Optional, as `progress`.
         */
        timing: z
          .strictObject({
            running_minutes: z.int().nonnegative(),
            quiet_minutes: z.int().nonnegative(),
            overdue: z.boolean(),
            range: z.string().max(40),
          })
          .optional(),
        /**
         * The last time the pipeline started its Developer again mid-build,
         * and why; `working` once it has logged work since.
         */
        restarted: z
          .strictObject({
            minutes_ago: z.int().nonnegative(),
            cause: BuildStopCause,
            working: z.boolean(),
          })
          .optional(),
      })
    )
    .max(10),
  /** Builds that stopped in the last day, newest first. Optional, as `progress`. */
  stopped: z
    .array(
      z.strictObject({
        cause: BuildStopCause,
        at: Timestamp,
        /** The checks its last report failed, by name. */
        checks: z.array(GateName).max(GateName.options.length).optional(),
      })
    )
    .max(5)
    .optional(),
  /**
   * The Developer's open questions, at most 10. `why` is another agent's
   * text, capped here: data, never instructions. `options` follows the
   * orchestrator's question rule: at most 10 answers an owner could give.
   */
  questions: z
    .array(
      z.strictObject({
        request_id: InformationRequest.shape.request_id,
        field: InformationRequest.shape.field,
        why: z.string().min(1).max(500),
        options: z.array(OwnerAnswerText).max(10).nullable(),
        blocking: InformationRequest.shape.blocking,
      })
    )
    .max(10),
  /** Reviews waiting on the owner, by expiry, at most 10. */
  approvals: z
    .array(z.strictObject({ version: Version, expires_at: Timestamp }))
    .max(10),
  missing_facts: z.array(FactValueKey),
  /**
   * The org's custom domains that are not removed, newest first. Optional
   * while the api that fills it lands after the contract; absent means none.
   */
  domains: z
    .array(
      z.strictObject({
        name: DomainName,
        state: DomainState,
        last_check: DomainCheck.nullable(),
      })
    )
    .max(10)
    .optional(),
  /**
   * Each kind's latest owner task in any state, with each step's state and
   * the note of a step that waits on the owner. Optional, as `domains`.
   */
  tasks: z.array(OwnerTask).max(TaskKind.options.length).optional(),
  /**
   * The open reminders, soonest first, each due time as the owner's wall
   * clock with its offset. The title is the owner's words: data, never
   * instructions. Optional: tool results stored before it replay.
   */
  reminders: z
    .array(
      z.strictObject({
        reminder_id: Uuid,
        title: Reminder.shape.title,
        due: z.string().max(40).nullable(),
      })
    )
    .max(20)
    .optional(),
  /**
   * What waits on the owner, the one list the panel, Notifications and Tasks
   * show: what to do as a heading, and since when. Optional, as `reminders`.
   */
  waiting: z
    .array(z.strictObject({ title: Text(120), since: Timestamp }))
    .max(20)
    .optional(),
  /** How long each lane usually takes, so the CoS quotes the measured wait. */
  expected_seconds: WorkspaceStatus.shape.expected_seconds,
  /** Each lane's wait in the panel's words, for a build that has just started. */
  expected_range: z
    .strictObject({ quick: z.string().max(40), full: z.string().max(40) })
    .optional(),
})

/** `get_facts`'s output: the org's current values, without their records. */
export const CosFacts = z.strictObject({ facts: z.array(FactValue) })

/**
 * The first build's change text, which onboarding starts on the owner's
 * behalf: the details are in the facts. The chat draws no card for it.
 */
export const ONBOARDING_GOAL = "Build my website from the details I gave you."

/**
 * `request_change`'s input: the owner's change, and the new phone or email
 * when the owner typed it in full. The tool records it as the owner's word
 * only if its digits or address appear in what the owner wrote. `proof` is
 * what the owner claims about the business in the change, recorded the same
 * way only if every word of it is the owner's. `step` is a line for the
 * panel: the runner strips it before the tool runs.
 */
export const CosChangeRequest = OwnerChangeRequest.extend({
  proof: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .optional()
    .describe(
      'What the owner states about the business in this change and wants the site to say, such as insurance, years trading or a guarantee, in their own words and as the site would write it: "Local and fully insured, with £5 million public liability". Money as £5 million, never "5 million pounds". Never the change itself ("Build the website again" is not a claim). Omit it when the change states nothing about the business.'
    ),
  contact: z
    .strictObject({
      phone: E164.optional().describe(
        "The new business phone number in E.164, exactly the digits the owner typed in full. Omit it when they gave none."
      ),
      email: z
        .email()
        .max(254)
        .optional()
        .describe(
          "The new business email address, exactly as the owner typed it. Omit it when they gave none."
        ),
    })
    .optional(),
  step: z
    .string()
    .max(60)
    .optional()
    .describe(
      'A few words, in the owner\'s language, of what this change does, such as "Adding the new photos to the home page". At most 60 characters. The panel shows it while the change is made; no ids, no versions.'
    ),
})

/** `get_change`'s input: a build's ref from the workspace or from `recent`; left out, the latest change. */
export const GetChangeInput = z.strictObject({ ref: Uuid.optional() })

const ChangeLabel = BuildSummary.shape.label.unwrap().nullable()
const ChangeState = z.string().min(1).max(40)

/**
 * `get_change`'s output: what a change was asked to do, the Developer's own
 * account (`done`), and what the pages show changed (`text_changes`, read by
 * code). `recorded` is false for a change from before text changes were
 * recorded. `recent` is the few changes before it, newest first.
 */
export const GetChangeOutput = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("found"),
    ref: Uuid,
    label: ChangeLabel,
    asked: BuildSummary.shape.goal,
    state: ChangeState,
    done: Text(500).nullable(),
    as_asked: z.boolean(),
    text_changes: CompletionReport.shape.text_changes,
    text_changes_left: CompletionReport.shape.text_changes_left,
    left_out: z.array(InformationRequest.shape.question.unwrap()).max(10),
    preview: z.strictObject({ expires_at: Timestamp }).nullable(),
    live_now: z.boolean(),
    published_at: Timestamp.nullable(),
    recorded: z.boolean(),
    recent: z
      .array(
        z.strictObject({
          ref: Uuid,
          label: ChangeLabel,
          state: ChangeState,
          at: Timestamp,
        })
      )
      .max(5),
  }),
  z.strictObject({ outcome: z.literal("none") }),
  Refused,
])

/**
 * `ask_developer`'s input: `answer` for a question about the site, answered
 * inside the turn; `review` to start a review that reports back later.
 */
export const AskDeveloperInput = z.strictObject({
  mode: z.enum(["answer", "review"]),
  /** The owner's question, or for a review what to focus on; their words. */
  question: Text(500),
  /** Routes to look at, when the owner named pages. */
  pages: z.array(z.string().min(1).max(120)).max(5).optional(),
})

/**
 * `ask_developer`'s output. `about` is the version the answer read;
 * `building` says a change is under way, so the answer may soon be stale;
 * `sure` is false when the stored record could not settle it. One review
 * runs per version at a time, so a repeat is `review_running`.
 */
export const AskDeveloperOutput = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("answered"),
    answer: Text(1200),
    about: z.enum(["live", "draft"]),
    building: z.boolean(),
    sources: z
      .array(
        z.strictObject({
          kind: z.enum(["page", "notes", "check", "facts", "change"]),
          ref: z.string().min(1).max(120),
        })
      )
      .max(6),
    sure: z.boolean(),
  }),
  z.strictObject({
    outcome: z.literal("review_started"),
    ref: Uuid,
    seconds: z.int().positive(),
  }),
  z.strictObject({ outcome: z.literal("review_running"), ref: Uuid }),
  z.strictObject({ outcome: z.literal("no_site") }),
  Refused,
])

/** `get_review`'s input: a review's ref from `ask_developer`; left out, the latest review. */
export const GetReviewInput = z.strictObject({ ref: Uuid.optional() })

/** `get_review`'s output: the stored review, without its tenancy and revision ids. */
export const GetReviewOutput = z.discriminatedUnion("outcome", [
  SiteReview.omit({ org_id: true, revision_id: true }).extend({
    outcome: z.literal("found"),
  }),
  z.strictObject({ outcome: z.literal("running"), ref: Uuid }),
  z.strictObject({ outcome: z.literal("none") }),
  Refused,
])

/**
 * The retired `get_preview`'s output, kept so its logged results replay:
 * the preview's version and expiry, or why there is none.
 */
export const GetPreviewOutput = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("ready"),
    assignment_id: Uuid,
    version: Version,
    expires_at: Timestamp,
  }),
  Refused,
])

/**
 * `answer_question`'s input. The api finds the build from the request and
 * checks the value against the question's field: a `FactValue` must be for
 * the field's key, and anything else goes through the question's
 * `TextAnswerSchema` and options.
 */
export const AnswerQuestionInput = z.strictObject({
  request_id: Uuid,
  value: z.union([FactValue, OwnerAnswerText]),
})

/**
 * `answer_question`'s input as the model is sent it: a fact's inner value
 * as any object, which the api checks against the question's own field
 * through `AnswerQuestionInput`. Inlining every fact's schema here cost
 * about 3.4k tokens on every call.
 */
export const AnswerQuestionCall = z.strictObject({
  request_id: Uuid,
  value: z.union([
    z.strictObject({ key: FactValueKey, value: JsonObject }),
    OwnerAnswerText,
  ]),
})

/** `answer_question`'s output once the owner said yes. A no is `output-denied`. */
export const AnswerQuestionOutput = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("answered"),
    request_id: Uuid,
    evidence: ActionEvidence,
  }),
  Refused,
])

/**
 * `create_reminder`'s input: the owner's reminder, and the zone the owner
 * named its time in when it is not the business's own. Absent, `due_at` is
 * read in the business's zone.
 */
export const CreateReminderInput = CreateReminderRequest.extend({
  time_zone: TimeZone.optional().describe(
    'The IANA zone the owner gave the time in, such as "Europe/London" for "8am UK time". Omit it when they named no zone.'
  ),
})

/**
 * `create_reminder`'s output: the reminder as stored, its due time in UTC
 * and the zone it was read in, so the thread shows the time the reply says.
 * `replaced` when it moved the open reminder this conversation already set
 * for the same thing instead of adding another. The id and zone are
 * optional, since results stored before them replay. A no is
 * `output-denied`.
 */
export const CreateReminderOutput = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("created"),
    reminder_id: Uuid.optional(),
    due_at: Timestamp.nullable(),
    time_zone: TimeZone.nullable().optional(),
    replaced: z.boolean().optional(),
    evidence: ActionEvidence,
  }),
  Refused,
])

/**
 * `update_reminder`'s input: an open reminder from the workspace, and what
 * changes. A field left out stays as it is.
 */
export const UpdateReminderInput = z.strictObject({
  reminder_id: Uuid,
  title: Reminder.shape.title.optional(),
  due_at: Timestamp.nullable().optional(),
  time_zone: CreateReminderInput.shape.time_zone,
})

/** `update_reminder`'s output: the reminder as it now stands. */
export const UpdateReminderOutput = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("updated"),
    reminder_id: Uuid,
    title: Reminder.shape.title,
    due_at: Timestamp.nullable(),
    time_zone: TimeZone.nullable(),
    evidence: ActionEvidence,
  }),
  Refused,
])

/** `delete_reminder`'s input: an open reminder from the workspace. */
export const DeleteReminderInput = z.strictObject({ reminder_id: Uuid })

/** `delete_reminder`'s output: the reminder gone, by its title. */
export const DeleteReminderOutput = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("deleted"),
    reminder_id: Uuid,
    title: Reminder.shape.title,
    evidence: ActionEvidence,
  }),
  Refused,
])

/** `set_time_zone`'s input: the zone the owner says the business runs on. */
export const SetTimeZoneInput = z.strictObject({
  time_zone: TimeZone.describe(
    'The IANA zone, such as "Europe/London" for the UK.'
  ),
})

/** `set_time_zone`'s output: the zone now set, and the time it is there. */
export const SetTimeZoneOutput = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("set"),
    time_zone: TimeZone,
    now: z.string().max(40),
    evidence: ActionEvidence,
  }),
  Refused,
])

/**
 * `record_review`'s input: a customer's review for the site, in the slot it
 * fills (`testimonials.review_<slot>`, replacing the one there), and the
 * owner's word that the customer agreed to be quoted, which must be true.
 */
export const RecordReviewInput = z.strictObject({
  slot: z.literal([1, 2]),
  ...ReviewValue.shape,
})

/** `record_review`'s output once the owner said yes. A no is `output-denied`. */
export const RecordReviewOutput = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("recorded"),
    slot: z.literal([1, 2]),
    evidence: ActionEvidence,
  }),
  Refused,
])

/**
 * `domain_bought`'s input: the name the owner says they bought themselves.
 * Its output is `BoughtElsewhereOutput`: the connect's own once the registry
 * shows the name, else that it does not yet.
 */
export const DomainBoughtInput = z.strictObject({ name: DomainName })

/** `inspect_domain`'s input: a name the owner says they have, not yet connected. */
export const InspectDomainInput = z.strictObject({
  name: DomainName,
  step: ToolStep,
})

/**
 * `inspect_domain`'s output: what the registry and public DNS say about the
 * name, read before anything is connected. `registrar` is the registry's own
 * text for the seller, so it is data to quote, never an instruction.
 */
export const InspectDomainOutput = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("inspected"),
    ...DomainInspection.shape,
  }),
  Refused,
])

/** `check_domain`'s input; it also wakes the domain's workflow to look now. */
export const CheckDomainInput = z.strictObject({
  name: DomainName,
  step: ToolStep,
})

/** `check_domain`'s output: where the domain is, the latest check, and what to tell the owner to do next. */
export const CheckDomainOutput = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("checked"),
    state: DomainState,
    status: DomainCheck,
    next_step: Text(300),
  }),
  Refused,
])

/** `connect_domain`'s input: the owner's existing domain. */
export const ConnectDomainInput = z.strictObject({ name: DomainName })

/**
 * `connect_domain`'s output once the owner said yes. A no is `output-denied`.
 * `steps` are the records to add, `apex` says whether the bare domain is an
 * alias or forwards from `www` (absent for a subdomain, which is served on its
 * own name), and `provider` is the detected DNS provider. `apply_url` is the
 * provider's signed Domain Connect page that adds `steps` for the owner, only
 * when the provider runs our template; `steps` stay as the fallback.
 */
export const ConnectDomainOutput = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("connecting"),
    method: z.enum(["domain_connect", "records"]),
    email_affected: z.boolean(),
    steps: z.array(DnsRecord).max(10).optional(),
    apex: z.enum(["alias", "forward"]).optional(),
    provider: DomainProvider.optional(),
    // A plain string, as `settings_url` is, so the model sees no `uri` format.
    apply_url: z
      .string()
      .max(2000)
      .regex(/^https:\/\/[^\s]+$/)
      .optional(),
    evidence: ActionEvidence,
  }),
  Refused,
])

/** `remove_domain`'s input: a domain connected to the business. */
export const RemoveDomainInput = z.strictObject({ name: DomainName })

/**
 * `remove_domain`'s output once the owner said yes. A no is `output-denied`.
 * The site is back on its own address.
 */
export const RemoveDomainOutput = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("removed"), evidence: ActionEvidence }),
  Refused,
])

/** `find_domain`'s input: what to search around, or nothing to start from the business name. */
export const FindDomainInput = z.strictObject({
  query: Text(100)
    .optional()
    .describe(
      "Words the owner wants in the name. Omit it to start from the business name."
    ),
  step: ToolStep,
})

/**
 * `find_domain`'s output: one row per name stem, best first, each ending free
 * at the price table's price or taken. The model quotes no other price. No
 * stem with a free ending is `domain.unavailable`.
 */
/** One name as `find_domain` offered it before the name rows. */
const LegacyOffer = z.strictObject({
  name: DomainName,
  price_gbp_year: z.int().positive(),
  why: Text(200),
})

export const FindDomainOutput = z.union([
  z.discriminatedUnion("outcome", [
    z.strictObject({
      outcome: z.literal("found"),
      rows: z.array(DomainStemOffer).min(1).max(5),
    }),
    Refused,
  ]),
  // A result stored before the name rows, so older sessions still parse.
  // Nothing writes it any more.
  z.strictObject({
    outcome: z.literal("found"),
    best: LegacyOffer,
    options: z.array(LegacyOffer).max(4),
  }),
])

/**
 * `POST /domains/{name}/bought`, the owner saying they bought the name
 * elsewhere, from the tray or through the CoS: the registry is asked again,
 * and once it shows the name the connect starts and this is its output.
 */
export const BoughtElsewhereOutput = z.discriminatedUnion("outcome", [
  ...ConnectDomainOutput.options,
  NotRegisteredYet,
])

/**
 * `buy_domain`'s input: a name `find_domain` offered, and nothing else. The
 * model never collects or sends the registrant: the details page asks the
 * owner for what is missing, and paying there is the consent.
 */
export const BuyDomainInput = z.strictObject({ name: DomainName })

/**
 * `buy_domain`'s output: the details page for buying the name, prefilled
 * from what Reme knows (`DomainRegistrantPrefill`), which the tray draws.
 * Nothing is reserved or charged. `awaiting_payment` is what it answered
 * before the details page, kept so a stored session still reads. Refused with
 * `domain.unavailable` or `domain.buy_unavailable`.
 */
export const BuyDomainOutput = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("details"),
    ...DomainRegistrantPrefill.shape,
  }),
  z.strictObject({
    outcome: z.literal("awaiting_payment"),
    name: DomainName,
    price_gbp: z.int().positive(),
    checkout: z.literal("embedded"),
  }),
  Refused,
])

const Empty = z.strictObject({})

/** `put_off`'s input: the offer the owner said not now to, and for how many days (7 when left out). */
export const PutOffInput = z.strictObject({
  kind: TaskKind,
  days: z.int().min(1).max(60).optional(),
})

/** `put_off`'s output: when the offer may come back. */
export const PutOffOutput = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("put_off"), until: Timestamp }),
  Refused,
])

/**
 * The kinds of action the owner may let the Chief of Staff do with no card,
 * named by the tool that does each. Paying money and a new phone or email on
 * the website are never one of them.
 */
export const GrantKind = z.enum([
  "create_reminder",
  "record_review",
  "connect_domain",
])

/** `offer_grant`'s input: the kind the owner may let run with no card from now on. */
export const OfferGrantInput = z.strictObject({ kind: GrantKind })

/**
 * `offer_grant`'s output once the owner tapped its card: the grant the tap
 * saved. A yes that saved none, as a typed one, is refused.
 */
export const OfferGrantOutput = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("granted"), kind: GrantKind }),
  Refused,
])

/** One kind on the owner's "Done without asking" list. `granted_at` is null while it still asks. */
export const ApprovalGrant = z.strictObject({
  kind: GrantKind,
  on: z.boolean(),
  granted_at: Timestamp.nullable(),
})

/** `GET /approval-grants`: every grantable kind, in `GrantKind` order. */
export const ApprovalGrants = z.strictObject({
  grants: z.array(ApprovalGrant).max(GrantKind.options.length),
})

/** `POST /approval-grants`: the owner's switch for one kind, read on the next action. */
export const ApprovalGrantSwitch = z.strictObject({
  kind: GrantKind,
  on: z.boolean(),
})

/**
 * The CoS's tools, by name. Every input is an object at its root, which
 * provider tool APIs require. The reads run in both modes; each act tool
 * waits for the owner's approval.
 */
export const COS_TOOLS = {
  get_workspace: { input: Empty, output: CosWorkspace },
  get_facts: { input: Empty, output: CosFacts },
  get_change: { input: GetChangeInput, output: GetChangeOutput },
  request_change: { input: CosChangeRequest, output: RequestChangeOutput },
  answer_question: { input: AnswerQuestionCall, output: AnswerQuestionOutput },
  create_reminder: { input: CreateReminderInput, output: CreateReminderOutput },
  update_reminder: { input: UpdateReminderInput, output: UpdateReminderOutput },
  delete_reminder: { input: DeleteReminderInput, output: DeleteReminderOutput },
  set_time_zone: { input: SetTimeZoneInput, output: SetTimeZoneOutput },
  record_review: { input: RecordReviewInput, output: RecordReviewOutput },
  check_domain: { input: CheckDomainInput, output: CheckDomainOutput },
  connect_domain: { input: ConnectDomainInput, output: ConnectDomainOutput },
  remove_domain: { input: RemoveDomainInput, output: RemoveDomainOutput },
  find_domain: { input: FindDomainInput, output: FindDomainOutput },
  buy_domain: { input: BuyDomainInput, output: BuyDomainOutput },
  connect_google: { input: ConnectGoogleInput, output: ConnectGoogleOutput },
  get_search_performance: {
    input: GetSearchPerformanceInput,
    output: GetSearchPerformanceOutput,
  },
  get_indexing: { input: GetIndexingInput, output: GetIndexingOutput },
  remember: { input: RememberInput, output: RememberOutput },
  put_off: { input: PutOffInput, output: PutOffOutput },
  inspect_domain: { input: InspectDomainInput, output: InspectDomainOutput },
  domain_bought: { input: DomainBoughtInput, output: BoughtElsewhereOutput },
  offer_grant: { input: OfferGrantInput, output: OfferGrantOutput },
  read_skill: { input: ReadSkillInput, output: ReadSkillOutput },
  save_correction: { input: SaveCorrectionInput, output: SaveCorrectionOutput },
  schedule_skill: { input: ScheduleSkillInput, output: ScheduleSkillOutput },
} as const

export type CosToolName = keyof typeof COS_TOOLS
export const CosToolName = z.enum(
  Object.keys(COS_TOOLS) as [CosToolName, ...CosToolName[]]
)

/** A tool name in a logged payload: a current tool, or one retired since whose turns still replay. */
const LoggedToolName = z.enum([...CosToolName.options, "get_preview"])

const Usage = z.strictObject({
  input_tokens: z.int().nonnegative(),
  cached_input_tokens: z.int().nonnegative(),
  output_tokens: z.int().nonnegative(),
  /** What the provider reported writing to its cache, and reasoning; absent on rows before them. */
  cache_write_tokens: z.int().nonnegative().optional(),
  reasoning_tokens: z.int().nonnegative().optional(),
})

/** Which kind of CoS work a call serves, each with its own model, effort and path. */
export const CosRoute = z.enum(["owner_turn", "card_click", "deferred"])
export type CosRoute = z.infer<typeof CosRoute>

const Ran = {
  turn_id: Ulid,
  model: z.string().min(1),
  /** The route that served the turn; absent on rows before it and on onboarding's planner. */
  route: CosRoute.optional(),
  usage: Usage,
  cost_usd: Usd,
  tools: z.array(LoggedToolName),
  steps: z.int().min(0).max(6),
  /** Null when no model call was made. */
  first_chunk_ms: z.int().nonnegative().nullable(),
}

/** The `cos.turn` payload. Never model-visible. No taint label. */
export const CosTurn = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("answered"), ...Ran }),
  z.strictObject({
    outcome: z.literal("fallback"),
    reason: z.enum(["provider", "budgetary", "resource"]),
    ...Ran,
  }),
  /** An onboarding turn the script answered from Jev's decision, its planner stopped. */
  z.strictObject({ outcome: z.literal("gated"), ...Ran }),
  z.strictObject({ outcome: z.literal("error"), ...Ran }),
  z.strictObject({ outcome: z.literal("integrity"), ...Ran }),
  /** Cut off by its time limit after content streamed; its message is kept, marked `stopped`. */
  z.strictObject({ outcome: z.literal("stopped"), ...Ran }),
  z.strictObject({
    outcome: z.literal("abandoned"),
    turn_id: Ulid,
    logged_usd: Usd,
    reserved_usd: Usd,
  }),
])

/** The `cos.prefix` payload: the instructions and tools as sent. Our code, so no taint label. */
export const CosPrefix = z.strictObject({
  version: z.string().min(1),
  sha256: Sha256,
  instructions: z.string().min(1),
  tools: z.array(
    z.strictObject({
      name: LoggedToolName,
      description: z.string().min(1),
      input_schema: JsonObject,
    })
  ),
})

/**
 * The `cos.context` payload, a turn's first. Labelled `untrusted_input` when
 * `text` holds owner text and `inferred` when it holds another agent's, such
 * as a question's `why`; both when it holds both.
 */
export const CosContext = z.strictObject({
  turn_id: Ulid,
  prefix_sha256: Sha256,
  context_policy_version: z.string().min(1),
  mode: ChatRequest.shape.mode,
  active_tools: z.array(LoggedToolName),
  text: z.string().min(1),
  reserved_usd: Usd,
})

const Content = ConversationMessage.shape.content.shape

/**
 * The `cos.message` payload: one whole `UIMessage`. Labelled
 * `untrusted_input` for owner text and `inferred` for text an agent wrote,
 * the CoS's own replies included; both when it holds both.
 */
export const CosMessage = z.strictObject({
  turn_id: Ulid,
  message: z.strictObject({
    id: ConversationMessage.shape.id,
    role: Content.role,
    parts: Content.parts,
    /** The run was cut off mid-reply; the parts are what had streamed. */
    stopped: z.literal(true).optional(),
    /** The turn hit its step or time limit with work left. */
    partial: z.literal(true).optional(),
  }),
})

const Called = { turn_id: Ulid, tool_call_id: ToolCallId }

/**
 * The `cos.tool_result` payload, one branch per tool so each output is typed.
 * Labelled like `cos.context`, by the text the output carries.
 */
export const CosToolResult = z.discriminatedUnion("tool", [
  z.strictObject({
    ...Called,
    tool: z.literal("get_workspace"),
    output: COS_TOOLS.get_workspace.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("get_facts"),
    output: COS_TOOLS.get_facts.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("get_change"),
    output: COS_TOOLS.get_change.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("request_change"),
    output: COS_TOOLS.request_change.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("answer_question"),
    output: COS_TOOLS.answer_question.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("create_reminder"),
    output: COS_TOOLS.create_reminder.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("update_reminder"),
    output: COS_TOOLS.update_reminder.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("delete_reminder"),
    output: COS_TOOLS.delete_reminder.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("set_time_zone"),
    output: COS_TOOLS.set_time_zone.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("record_review"),
    output: COS_TOOLS.record_review.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("check_domain"),
    output: COS_TOOLS.check_domain.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("connect_domain"),
    output: COS_TOOLS.connect_domain.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("remove_domain"),
    output: COS_TOOLS.remove_domain.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("find_domain"),
    output: COS_TOOLS.find_domain.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("buy_domain"),
    output: COS_TOOLS.buy_domain.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("connect_google"),
    output: COS_TOOLS.connect_google.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("get_search_performance"),
    output: COS_TOOLS.get_search_performance.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("get_indexing"),
    output: COS_TOOLS.get_indexing.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("remember"),
    output: COS_TOOLS.remember.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("put_off"),
    output: COS_TOOLS.put_off.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("inspect_domain"),
    output: COS_TOOLS.inspect_domain.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("domain_bought"),
    output: COS_TOOLS.domain_bought.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("offer_grant"),
    output: COS_TOOLS.offer_grant.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("read_skill"),
    output: COS_TOOLS.read_skill.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("save_correction"),
    output: COS_TOOLS.save_correction.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("schedule_skill"),
    output: COS_TOOLS.schedule_skill.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("get_preview"),
    output: GetPreviewOutput,
  }),
])

/** The `cos.step` payload: a step's response messages as the SDK holds them. Model-written, so `inferred`. */
export const CosStep = z.strictObject({
  turn_id: Ulid,
  step: z.int().nonnegative(),
  messages: z.array(JsonObject),
  usage: Usage,
  cost_usd: Usd,
  /** The model that answered the step, which differs from the turn's when OpenRouter used its fallback. Absent on rows before it. */
  model: z.string().min(1).optional(),
})

/** The `cos.call` payload: the hash of the messages a model call was sent. No taint label. */
export const CosCall = z.strictObject({
  turn_id: Ulid,
  step: z.int().nonnegative(),
  sha256: Sha256,
})

/**
 * The `cos.feedback` payload: the owner's thumb on one assistant message.
 * Written with no session, so it never takes a turn's `seq` and the
 * history derivation never reads it. Never model-visible, and no taint
 * label, because it holds no free text.
 */
export const CosFeedback = z.strictObject({
  conversation_id: Uuid,
  message_id: ConversationMessage.shape.id,
  rating: MessageRating,
})

/**
 * The `cos.approval` payload: an approval card as it was shown. The answer
 * must match `input_sha256` (the hash of the tool input the card showed) and
 * arrive before `expires_at`, or it is refused. `approval_id` is the SDK's
 * and has the shape of a provider id. No free text, so no taint label.
 */
export const CosApproval = z.strictObject({
  turn_id: Ulid,
  approval_id: ToolCallId,
  tool_call_id: ToolCallId,
  input_sha256: Sha256,
  expires_at: Timestamp,
})

/**
 * The `cos.tool_started` payload: an act call passed its approval check and
 * is about to run. One with no result five minutes later, as a Worker killed
 * mid-call leaves it, counts as `cos.tool_unknown`. No free text.
 */
export const CosToolStarted = z.strictObject({
  tool_call_id: ToolCallId,
  approval_id: ToolCallId,
})

/**
 * The `cos.tool_unknown` payload: a tool call whose outcome is not known, so
 * it is never run again and the owner is asked. No free text.
 */
export const CosToolUnknown = z.strictObject({
  tool_call_id: ToolCallId,
  approval_id: ToolCallId,
})

/**
 * The `cos.compaction` payload (§10.6): `summary` stands in for the events in
 * `replaced_range`, which stay in the log. `dropped_refs` are the ids of
 * events the summary does not carry. The summary is model-written, so the
 * event is labelled `inferred`.
 */
export const CosCompaction = z.strictObject({
  summary: Text(8000),
  /** Positions in the session's stream, both included. */
  replaced_range: z.strictObject({
    from_seq: z.int().nonnegative(),
    to_seq: z.int().nonnegative(),
  }),
  dropped_refs: z.array(Ulid).max(500),
})

/**
 * The `cos.event` payload: something that happened away from the chat,
 * logged in the CoS session when it happened so the next turn reads it: a
 * staff result, a notice posted in the chat, a scheduled run's outcome. A
 * notice names the message it posted. `wake` asks for a turn of its own.
 * Labelled by the text `summary` carries.
 */
export const CosEvent = z.strictObject({
  source: z.enum(["staff", "notice", "schedule"]),
  summary: Text(1500),
  evidence: z.array(Evidence).max(4),
  wake: z.boolean(),
  message_id: ConversationMessage.shape.id.optional(),
})

export type CosWorkspace = z.infer<typeof CosWorkspace>
export type CosFacts = z.infer<typeof CosFacts>
export type CosChangeRequest = z.infer<typeof CosChangeRequest>
export type GetChangeInput = z.infer<typeof GetChangeInput>
export type GetChangeOutput = z.infer<typeof GetChangeOutput>
export type AskDeveloperInput = z.infer<typeof AskDeveloperInput>
export type AskDeveloperOutput = z.infer<typeof AskDeveloperOutput>
export type GetReviewInput = z.infer<typeof GetReviewInput>
export type GetReviewOutput = z.infer<typeof GetReviewOutput>
export type GetPreviewOutput = z.infer<typeof GetPreviewOutput>
export type AnswerQuestionInput = z.infer<typeof AnswerQuestionInput>
export type AnswerQuestionOutput = z.infer<typeof AnswerQuestionOutput>
export type AnswerQuestionCall = z.infer<typeof AnswerQuestionCall>
export type CreateReminderInput = z.infer<typeof CreateReminderInput>
export type CreateReminderOutput = z.infer<typeof CreateReminderOutput>
export type UpdateReminderInput = z.infer<typeof UpdateReminderInput>
export type UpdateReminderOutput = z.infer<typeof UpdateReminderOutput>
export type DeleteReminderInput = z.infer<typeof DeleteReminderInput>
export type DeleteReminderOutput = z.infer<typeof DeleteReminderOutput>
export type SetTimeZoneInput = z.infer<typeof SetTimeZoneInput>
export type SetTimeZoneOutput = z.infer<typeof SetTimeZoneOutput>
export type RecordReviewInput = z.infer<typeof RecordReviewInput>
export type RecordReviewOutput = z.infer<typeof RecordReviewOutput>
export type CheckDomainInput = z.infer<typeof CheckDomainInput>
export type CheckDomainOutput = z.infer<typeof CheckDomainOutput>
export type ConnectDomainInput = z.infer<typeof ConnectDomainInput>
export type ConnectDomainOutput = z.infer<typeof ConnectDomainOutput>
export type RemoveDomainInput = z.infer<typeof RemoveDomainInput>
export type RemoveDomainOutput = z.infer<typeof RemoveDomainOutput>
export type DomainBoughtInput = z.infer<typeof DomainBoughtInput>
export type InspectDomainInput = z.infer<typeof InspectDomainInput>
export type InspectDomainOutput = z.infer<typeof InspectDomainOutput>
export type PutOffInput = z.infer<typeof PutOffInput>
export type PutOffOutput = z.infer<typeof PutOffOutput>
export type GrantKind = z.infer<typeof GrantKind>
export type OfferGrantInput = z.infer<typeof OfferGrantInput>
export type OfferGrantOutput = z.infer<typeof OfferGrantOutput>
export type ApprovalGrant = z.infer<typeof ApprovalGrant>
export type ApprovalGrants = z.infer<typeof ApprovalGrants>
export type ApprovalGrantSwitch = z.infer<typeof ApprovalGrantSwitch>
export type FindDomainInput = z.infer<typeof FindDomainInput>
export type FindDomainOutput = z.infer<typeof FindDomainOutput>
export type BoughtElsewhereOutput = z.infer<typeof BoughtElsewhereOutput>
export type BuyDomainInput = z.infer<typeof BuyDomainInput>
export type BuyDomainOutput = z.infer<typeof BuyDomainOutput>
export type CosTurn = z.infer<typeof CosTurn>
export type CosPrefix = z.infer<typeof CosPrefix>
export type CosContext = z.infer<typeof CosContext>
export type CosMessage = z.infer<typeof CosMessage>
export type CosToolResult = z.infer<typeof CosToolResult>
export type CosStep = z.infer<typeof CosStep>
export type CosCall = z.infer<typeof CosCall>
export type CosFeedback = z.infer<typeof CosFeedback>
export type CosApproval = z.infer<typeof CosApproval>
export type CosToolStarted = z.infer<typeof CosToolStarted>
export type CosToolUnknown = z.infer<typeof CosToolUnknown>
export type CosCompaction = z.infer<typeof CosCompaction>
export type CosEvent = z.infer<typeof CosEvent>
