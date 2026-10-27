import {
  AGENT_NOTE,
  type AnswerQuestionInput,
  type AnswerQuestionOutput,
  BoughtElsewhereOutput,
  BuildStopCause,
  BuildSummary,
  type BuyDomainInput,
  BuyDomainOutput,
  type CheckDomainInput,
  CheckDomainOutput,
  type ConnectDomainInput,
  ConnectDomainOutput,
  type CosChangeRequest,
  CosFacts,
  CosMessage,
  CosWorkspace,
  type CreateReminderOutput,
  type CreateReminderRequest,
  type DomainBoughtInput,
  DomainCheck,
  DomainInspection,
  ErrorEnvelope,
  type FactRecord,
  FactValue,
  FactValueKey,
  type FindDomainInput,
  FindDomainOutput,
  GateResult,
  type GetPreviewInput,
  GetPreviewOutput,
  InformationAnswer,
  type InspectDomainInput,
  type InspectDomainOutput,
  OwnerAnswerText,
  PreviewLink,
  type ProfileLine,
  type PutOffInput,
  type PutOffOutput,
  type QuestionAnswer,
  REVIEW_FACT_KEYS,
  type RecordReviewInput,
  type RecordReviewOutput,
  type RemoveDomainInput,
  type RemoveDomainOutput,
  RequestChangeOutput,
  type ReviewFactKey,
  TERMINAL_STATES,
  type WorkspaceStatus,
} from "@workspace/contracts"
import {
  assignments,
  domains,
  eq,
  events,
  failureCode,
  type OrgScopedDb,
  openTask,
  readTasks,
  siteRevisions,
  sql,
  type Tenancy,
} from "@workspace/db"
import { rangeText } from "@workspace/ui/lib/activity-copy"
import type { ModelMessage } from "ai"
import {
  type Bridged,
  bridge,
  holds,
  notFound,
  type Owner,
  relay,
  startChange,
  stateFacts,
} from "../changes.ts"
import { emailFromOwner, phoneFromOwner } from "../contact.ts"
import {
  buyConfigured,
  buyUnavailable,
  isOrgOwner,
  notOwner,
} from "../domain-buy.ts"
import { failure } from "../http.ts"
import { jevBought, jevPutOn } from "../jev.ts"
import {
  ASSISTANT_KEY_PREFIX,
  createReminder as storeReminder,
  wakeScheduler,
} from "../reminders.ts"
import { EXPECTED_SECONDS, readFacts, statusWithFacts } from "../workspace.ts"
import type { Opening } from "./agent.ts"
import { readSession } from "./history.ts"
import { contentWords, inOwnersWords, readProfile } from "./memory.ts"
import { wallToUtc } from "./time.ts"
import type { Turn } from "./turns.ts"

/**
 * The Chief of Staff's ten tools (ADR-034), as plain functions: the
 * session's org, user and session in, the contract's output out. What they
 * return is what the model reads, so each is cut to its `COS_TOOLS` output:
 * no org or staff id, no URL, no open record, and every refusal the closed
 * `{class, code, message}`. Each opens its own `withOrg`, outside any
 * conversation lock. The act tools take the approval id as their key, so
 * running one twice replays the first run.
 *
 * A refusal is only a definite no: a 4xx, from the api or from the
 * orchestrator's envelope. An answer at 5xx, a timeout, a lost call or an
 * answer off the contract, leaves the outcome unknown (ADR-034), so it is
 * thrown as `ToolFailed`, never returned: a stored refusal would close the
 * approved call, and the repair could no longer rerun it under its key.
 */

export type ToolContext = {
  env: Env
  kit: Tenancy
  owner: Owner
  /**
   * Folds a chat card as answered. Passed in, because the card is a
   * conversation row and this directory never reaches those (ADR-034).
   */
  settleCard: (
    db: OrgScopedDb,
    questionId: string,
    answer: QuestionAnswer
  ) => Promise<void>
}

type Empty = Record<string, never>
type Refused = Extract<GetPreviewOutput, { outcome: "refused" }>

/** Another agent's text, and any message, is capped where the model reads it. */
const TEXT_MAX = 500

/**
 * `text` in at most `TEXT_MAX` UTF-16 units, the unit the contracts count.
 * A cut through a surrogate pair drops its first half, since a lone
 * surrogate is not well-formed and some providers refuse the JSON.
 */
export function cut(text: string): string {
  const head = text.slice(0, TEXT_MAX)
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head
}

/** A call whose outcome nobody can vouch for, cut to what a log may hold. */
export class ToolFailed extends Error {
  constructor(
    readonly status: number,
    readonly error: Refused["error"]
  ) {
    super(error.code)
  }
}

/**
 * An api answer as the model reads it: its class, code and message, nothing
 * else. Thrown as `ToolFailed` unless it is a definite no.
 */
export async function refused(response: Response): Promise<Refused> {
  const envelope = ErrorEnvelope.parse(await response.json())
  const error = {
    class: envelope.class,
    code: envelope.code,
    message: cut(envelope.message),
  }
  if (response.status >= 500) throw new ToolFailed(response.status, error)
  return { outcome: "refused", error }
}

/**
 * A stored question's options, when they still fit the closed list the model
 * reads: at most 10, each an answer an owner could give. A list stored before
 * that rule is dropped whole and logged, since part of a closed list would
 * read as all of it.
 */
function optionsOf(requestId: string, options: string[] | null) {
  if (
    options === null ||
    (options.length <= 10 &&
      options.every((o) => OwnerAnswerText.safeParse(o).success))
  ) {
    return options
  }
  console.warn(
    JSON.stringify({ code: "cos.options_skipped", request_id: requestId })
  )
  return null
}

/** A domain the org still holds. */
const live = sql`${domains.state} <> 'removed'`

/** A Developer started again mid-build (the orchestrator's `noteResumed`). */
const resumed = sql`e.type = ${AGENT_NOTE} and e.payload->>'kind' = 'resumed'`

/** When a build last logged work and was last resumed, in epoch milliseconds. */
type Life = {
  work_ms: number | null
  resumed_ms: number | null
  cause: string | null
}

/** The states the pipeline works in, where how long a build has run means something. */
const WORKING = new Set<string>([
  "briefing",
  "planning",
  "implementing",
  "validating",
  "repairing",
  "revising",
])

const wholeMinutes = (ms: number) => Math.max(0, Math.floor(ms / 60_000))

/** A lane's wait in the panel's words, before any time has run. */
const rangeOf = (
  expected: WorkspaceStatus["expected_seconds"],
  lane: "quick" | "full"
) => {
  const { p50, p95 } = (expected ?? EXPECTED_SECONDS)[lane]
  return rangeText(p50, p95).text
}

/**
 * How long a build the pipeline is working on has run, how long since it
 * last logged work, and its last mid-build restart. The clock leaves out the
 * owner's plan reviews, as the panel's does.
 */
export function paceOf(
  build: Pick<BuildSummary, "state" | "lane" | "created_at" | "review_ms">,
  life: Life | undefined,
  expected: WorkspaceStatus["expected_seconds"],
  now: number
): Pick<CosWorkspace["builds"][number], "timing" | "restarted"> {
  if (!WORKING.has(build.state)) return {}
  const started = Date.parse(build.created_at)
  const ran = now - started - (build.review_ms ?? 0)
  const lane = (expected ?? EXPECTED_SECONDS)[build.lane ?? "full"]
  const range = rangeText(lane.p50, lane.p95, Math.max(0, ran / 1000))
  return {
    timing: {
      running_minutes: wholeMinutes(ran),
      quiet_minutes: wholeMinutes(now - (life?.work_ms ?? started)),
      overdue: range.longer,
      range: range.text,
    },
    ...(life?.resumed_ms != null && {
      restarted: {
        minutes_ago: wholeMinutes(now - life.resumed_ms),
        cause: BuildStopCause.catch("other").parse(life.cause),
        working: (life.work_ms ?? 0) > life.resumed_ms,
      },
    }),
  }
}

export async function getWorkspace(
  ctx: ToolContext,
  _input: Empty
): Promise<CosWorkspace> {
  return (await loadWorkspace(ctx)).workspace
}

/**
 * The workspace the model reads and the facts it was read with, in one
 * transaction: a turn's context needs both before its first token.
 */
export async function loadWorkspace({ env, kit, owner }: ToolContext): Promise<{
  workspace: CosWorkspace
  facts: FactRecord[]
  /** What the owner told the CoS about themselves. */
  profile: ProfileLine[]
  /** The open reminders with a time, soonest first, for a conversation's first turn. */
  reminders: Opening["reminders"]
}> {
  const now = new Date()
  const [read, rows, { lines: profile }, reports, repairs, lives] =
    await kit.withOrg({ orgId: owner.orgId }, (db) =>
      Promise.all([
        statusWithFacts(db, env, now),
        db
          .select({
            name: domains.name,
            state: domains.state,
            lastCheck: domains.lastCheck,
          })
          .from(domains)
          .where(live)
          .orderBy(sql`${domains.createdAt} desc`)
          .limit(10),
        readProfile(db),
        // Each build's last check report from the day, for what a stopped one failed.
        db.execute<{ assignment_id: string; gates: unknown }>(
          sql`select distinct on (assignment_id) assignment_id, payload->'gates' as gates from events where type = 'assignment.validation_reported' and occurred_at > now() - interval '24 hours' order by assignment_id, event_id desc`
        ),
        db.execute<{ assignment_id: string; rounds: number }>(
          sql`select assignment_id, count(*)::int as rounds from events where type = 'assignment.state_changed' and payload->>'to' = 'repairing' and occurred_at > now() - interval '24 hours' group by assignment_id`
        ),
        // Each open build's last logged work and last resume, for its pace.
        db.execute<Life & { assignment_id: string }>(
          sql`select e.assignment_id, (extract(epoch from max(e.occurred_at) filter (where e.type <> ${AGENT_NOTE})) * 1000)::float8 as work_ms, (extract(epoch from max(e.occurred_at) filter (where ${resumed})) * 1000)::float8 as resumed_ms, (array_agg(e.payload->>'cause' order by e.event_id desc) filter (where ${resumed}))[1] as cause from events e join assignments a on a.id = e.assignment_id where a.kind in ('site.build', 'site.revise') and a.state not in ${TERMINAL_STATES} group by e.assignment_id`
        ),
      ])
    )
  const { status, facts, tasks } = read
  const roundsOf = (assignmentId: string) =>
    [...repairs].find((r) => r.assignment_id === assignmentId)?.rounds ?? 0
  const failedChecks = (assignmentId: string | null) => {
    const report = [...reports].find((r) => r.assignment_id === assignmentId)
    const gates = GateResult.array().safeParse(report?.gates).data ?? []
    return gates.filter((g) => !g.passed).map((g) => g.gate)
  }
  const workspace = CosWorkspace.parse({
    site: {
      host: status.site.host,
      live_version: status.site.live?.version ?? null,
    },
    builds: status.builds.map((b) => ({
      assignment_id: b.assignment_id,
      kind: b.kind,
      state: b.state,
      lane: b.lane,
      goal: b.goal,
      version: b.revision?.version ?? null,
      ...(b.retry ? { retry: true } : {}),
      ...(roundsOf(b.assignment_id) > 0 &&
      ["repairing", "implementing", "validating"].includes(b.state)
        ? {
            fixing: {
              round: Math.min(roundsOf(b.assignment_id), 9),
              checks: failedChecks(b.assignment_id),
            },
          }
        : {}),
      progress: (b.activity ?? [])
        .filter((step) => !step.skipped)
        .map((step) => ({
          step: step.label,
          done: step.done,
          total: step.total,
          now: step.now === true,
        })),
      ...paceOf(
        b,
        [...lives].find((l) => l.assignment_id === b.assignment_id),
        status.expected_seconds,
        now.getTime()
      ),
    })),
    stopped: status.attention
      .flatMap((item) =>
        item.kind === "alert" && item.reason === "build_failed"
          ? [
              {
                cause: item.cause ?? "other",
                at: item.at,
                checks: failedChecks(item.assignment_id),
              },
            ]
          : []
      )
      .slice(0, 5),
    questions: status.attention
      .flatMap((item) => (item.kind === "question" ? [item.request] : []))
      .slice(0, 10)
      .map((r) => ({
        request_id: r.request_id,
        field: cut(r.field),
        why: cut(r.why),
        options: optionsOf(r.request_id, r.options),
        blocking: r.blocking,
      })),
    approvals: status.attention
      .flatMap((item) =>
        item.kind === "approval"
          ? [{ version: item.version, expires_at: item.request.expires_at }]
          : []
      )
      .slice(0, 10),
    missing_facts: status.missing_facts,
    domains: rows.map((r) => ({
      name: r.name,
      state: r.state,
      // A check stored before the contract changed reads as none yet.
      last_check: DomainCheck.safeParse(r.lastCheck).data ?? null,
    })),
    tasks,
    expected_seconds: status.expected_seconds,
    expected_range: {
      quick: rangeOf(status.expected_seconds, "quick"),
      full: rangeOf(status.expected_seconds, "full"),
    },
  })
  return {
    workspace,
    facts,
    profile,
    reminders: status.reminders.notes
      .filter((n) => n.due_at !== null)
      .slice(0, 5)
      .map((n) => ({ title: n.title, due_at: n.due_at })),
  }
}

/**
 * The stored rows as `FactValue`s. A row the contract now refuses, such as
 * hours stored before the rule that they close after they open, is left out
 * and named, so one old row never fails the list.
 */
function toCosFacts(rows: FactRecord[]): {
  output: CosFacts
  skipped: string[]
} {
  const facts: FactValue[] = []
  const skipped: string[] = []
  for (const row of rows) {
    const parsed = FactValue.safeParse({ key: row.key, value: row.value })
    if (parsed.success) facts.push(parsed.data)
    else skipped.push(row.key)
  }
  return { output: CosFacts.parse({ facts }), skipped }
}

export async function getFacts(
  { kit, owner }: ToolContext,
  _input: Empty
): Promise<CosFacts> {
  const rows = await kit.withOrg({ orgId: owner.orgId }, readFacts)
  const { output, skipped } = toCosFacts(rows)
  if (skipped.length > 0) {
    console.warn(
      JSON.stringify({
        code: "cos.facts_skipped",
        count: skipped.length,
        keys: skipped,
      })
    )
  }
  return output
}

/** The build's preview: its version and expiry, never the signed links. */
export async function getPreview(
  { env, kit, owner }: ToolContext,
  input: GetPreviewInput
): Promise<GetPreviewOutput> {
  const id = input.assignment_id
  if (!(await holds(kit, owner.orgId, assignments, id))) {
    return refused(notFound("assignment"))
  }
  const answered = relay(
    await bridge(env, owner, `/${id}/preview`, { method: "GET" }),
    PreviewLink.parse
  )
  if (!answered.ok) return refused(answered)
  const link = PreviewLink.parse(await answered.json())
  const [revision] = await kit.withOrg({ orgId: owner.orgId }, (db) =>
    db
      .select({ version: siteRevisions.version })
      .from(siteRevisions)
      .where(eq(siteRevisions.id, link.revision_id))
  )
  // The orchestrator named a revision this org does not hold: a mismatch
  // between the two sides, not a no.
  if (!revision) {
    throw new ToolFailed(502, {
      class: "integrity",
      code: "orchestrator.off_contract",
      message: "The builder named a preview this business does not hold.",
    })
  }
  return GetPreviewOutput.parse({
    outcome: "ready",
    assignment_id: id,
    version: revision.version,
    expires_at: link.expires_at,
  })
}

/**
 * Words or marks that put a change text near a phone or an email. "Call"
 * only as in "call us on": "don't call us a family firm" is not about one.
 */
const ABOUT_CONTACT =
  /phone|number|mobile|\bcall (?:us |me )?(?:on|at)\b|\bring\b|e-?mail|contact|@|\d{3}/i

const untyped = (what: string) =>
  failure(400, {
    class: "validation",
    code: "contact.not_typed",
    // The way out is in the message: a model that invented a placeholder
    // re-proposed it verbatim when told only to name it (staging, 2026-10-22).
    message: `That ${what} is not one the owner typed in this conversation, or the change text does not name it. If the owner gave no new ${what}, propose the change again without contact. Otherwise name it in the change, as the owner typed it, then propose again.`,
    detail: {},
  })

/** Something in the owner's words that could be a phone number or an email address. */
const TYPED_PHONE = /\d[\d\s().-]{6,}\d/
const TYPED_EMAIL = /\S@\S+\.\S/

/**
 * The phone and email in `input` the business does not hold yet: what a yes
 * on the change would record, so the change shows its card. Null when there
 * is none, or the change text never touches contact.
 */
export async function newContact(
  { kit, owner }: Pick<ToolContext, "kit" | "owner">,
  { contact, text }: CosChangeRequest,
  /** Everything the owner wrote in the conversation, when the caller has it. */
  said?: string
): Promise<{ phone?: string; email?: string } | null> {
  if (!contact?.phone && !contact?.email) return null
  // The owner approves the change text, which is all the card shows. A text
  // that never touches contact cannot depend on one, so a contact the model
  // added to it was never approved: dropped, not refused. On staging the
  // model filled `contact` on every hero change, invented or copied, and a
  // refusal asked the owner for the same yes again.
  // shortcut: a word test, not a parser; it errs towards "about contact", which keeps the refusal.
  if (!ABOUT_CONTACT.test(text)) {
    console.log(JSON.stringify({ code: "cos.contact_dropped" }))
    return null
  }
  // A value the business already holds is no change: the model restates the
  // current phone and email on unrelated changes (staging, 2026-10-22), and
  // refusing those asked the owner for the same yes twice.
  let heldPhone: string | undefined
  let heldEmail: string | undefined
  const rows = await kit.withOrg({ orgId: owner.orgId }, readFacts)
  for (const fact of toCosFacts(rows).output.facts) {
    if (fact.key === "business.phone") heldPhone = fact.value.e164
    if (fact.key === "business.email") heldEmail = fact.value.address
  }
  // A phone or email when the owner typed none at all is made up: on
  // 2026-10-25 "add our hours to the contact page" came with an invented
  // phone and email and asked for a yes. Dropped, never carded. One that
  // differs from what they typed is kept, for the refusal to correct.
  const invented = (gave: RegExp) => said !== undefined && !gave.test(said)
  const phone =
    !contact.phone || contact.phone === heldPhone || invented(TYPED_PHONE)
      ? undefined
      : contact.phone
  const email =
    !contact.email ||
    contact.email.toLowerCase() === heldEmail?.toLowerCase() ||
    invented(TYPED_EMAIL)
      ? undefined
      : contact.email
  return phone || email ? { phone, email } : null
}

/**
 * A new phone or email the owner typed in full, recorded as their fact
 * before the change starts, so the build reads the number the owner gave and
 * the content gate agrees with the site. The model proposes the value; it is
 * recorded only when the owner's own messages in `sessionId` hold the digits
 * or the address, so a number the model made up never becomes a fact. The
 * change text, which the owner reads on the card, must name it too.
 * Null when there is nothing to record or it is recorded, else the refusal.
 */
async function recordContact(
  { kit, owner }: Pick<ToolContext, "kit" | "owner">,
  sessionId: string,
  input: CosChangeRequest
): Promise<Response | null> {
  const said = (await ownerSaid({ kit, owner }, sessionId)).join("\n")
  const fresh = await newContact({ kit, owner }, input, said)
  if (!fresh) return null
  const { phone, email } = fresh
  const { text } = input
  const stated: FactValue[] = []
  if (phone) {
    if (!(phoneFromOwner(phone, said) && phoneFromOwner(phone, text)))
      return untyped("phone number")
    stated.push({ key: "business.phone", value: { e164: phone } })
  }
  if (email) {
    if (!(emailFromOwner(email, said) && emailFromOwner(email, text)))
      return untyped("email address")
    stated.push({ key: "business.email", value: { address: email } })
  }
  try {
    await kit.withOrg(
      { orgId: owner.orgId, workosUserId: owner.session.workosUserId },
      (db) => stateFacts(db, owner, stated)
    )
  } catch (error) {
    console.error(
      JSON.stringify({ code: "cos.contact_failed", error: failureCode(error) })
    )
    return failure(503, {
      class: "transient",
      code: "contact.unconfirmed",
      message: "The new contact detail could not be confirmed.",
      detail: {},
    })
  }
  return null
}

/** What the owner wrote in `sessionId`, message by message. */
export async function ownerSaid(
  { kit, owner }: Pick<ToolContext, "kit" | "owner">,
  sessionId: string
): Promise<string[]> {
  const log = await kit.withOrg({ orgId: owner.orgId }, (db) =>
    readSession(db, sessionId)
  )
  return log.flatMap((e): string[] => {
    const m = e.type === "cos.message" ? CosMessage.safeParse(e.payload) : null
    return m?.success && m.data.message.role === "user"
      ? m.data.message.parts.flatMap((p) =>
          p.type === "text" && typeof p.text === "string" ? [p.text] : []
        )
      : []
  })
}

/** A word that turns a claim around. */
const NEGATION = /\b(?:not|no|never|none|nor|without)\b|n['’]t\b/i

/**
 * Whether `proof` is something the owner said in `message`: every word of it
 * is one of the message's, and a message that negates something is used only
 * by a claim that negates too, since dropping a "not" keeps every word and
 * turns the claim around ("we're not insured yet" is not "Insured").
 * shortcut: errs towards refusing, so "no call-out fee, fully insured" cannot back "Fully insured"; a span match if that refuses real claims.
 */
export const statedIn = (proof: string, message: string) =>
  inOwnersWords(proof, [message], false) &&
  (!NEGATION.test(message) || NEGATION.test(proof))

/** A line that asks for something rather than saying something about the business ("Remove it"). */
const INSTRUCTION =
  /^\s*(?:please\s+)?(?:add|build|change|delete|do|drop|fix|make|move|put|rebuild|redo|remove|replace|restart|show|start|stop|take|try|update|use|can|could|would|will)\b/i

/** How long `business.proof` may grow: its fact's bound. */
const PROOF_MAX = 600

class ProofFull extends Error {}

/**
 * What the owner claims in a change ("local and fully insured"), added to
 * `business.proof` as their word before the build starts, so the build does
 * not ask for it and the claims gate accepts it. Recorded only when every
 * word of it is one the owner wrote in `sessionId`, so nothing the model
 * made up becomes a claim; any other claim is dropped. Null unless saving
 * failed, so the change starts whatever the model put in proof.
 */
async function recordProof(
  { kit, owner }: Pick<ToolContext, "kit" | "owner">,
  sessionId: string,
  { proof, text: change }: CosChangeRequest
): Promise<Response | null> {
  if (!proof) return null
  // An instruction, or the change itself, is not a claim about the business:
  // logged 2026-10-25, "Build the website again" and then "Remove it" landed
  // in the proof. Dropped, never refused, so the owner is not asked about it.
  if (
    INSTRUCTION.test(proof) ||
    (inOwnersWords(proof, [change], false) &&
      inOwnersWords(change, [proof], false))
  ) {
    return null
  }
  // A claim with a word the owner never wrote is dropped and the change
  // starts: refusing it made the model retry its own paraphrase twice before
  // the change began (2026-10-25). The change text still carries what they asked.
  const said = await ownerSaid({ kit, owner }, sessionId)
  if (!said.some((message) => statedIn(proof, message))) {
    console.log(
      JSON.stringify({ code: "cos.proof_dropped", reason: "not_owners" })
    )
    return null
  }
  try {
    await kit.withOrg(
      { orgId: owner.orgId, workosUserId: owner.session.workosUserId },
      async (db) => {
        const rows = await readFacts(db)
        const held = toCosFacts(rows).output.facts.find(
          (f) => f.key === "business.proof"
        )?.value.text
        if (held?.toLowerCase().includes(proof.toLowerCase())) return
        const text = held ? `${held.replace(/[\s.]+$/, "")}. ${proof}` : proof
        if (text.length > PROOF_MAX) throw new ProofFull()
        await stateFacts(
          db,
          owner,
          [{ key: "business.proof", value: { text } }],
          rows
        )
      }
    )
  } catch (error) {
    // Full is the server's to handle, not the model's: the change starts without it.
    if (error instanceof ProofFull) {
      console.log(JSON.stringify({ code: "cos.proof_dropped", reason: "full" }))
      return null
    }
    console.error(
      JSON.stringify({ code: "cos.proof_failed", error: failureCode(error) })
    )
    return failure(503, {
      class: "transient",
      code: "proof.unconfirmed",
      message: "What the owner said about the business could not be saved.",
      detail: {},
    })
  }
  return null
}

/**
 * The owner's change, started as `/changes` starts it, keyed by the
 * approval, after any contact detail and claim in it is recorded. Both ways a yes
 * reaches the change come here: the tool's body and the chat's approval.
 */
export async function startOwnerChange(
  context: Pick<ToolContext, "env" | "kit" | "owner">,
  sessionId: string,
  input: CosChangeRequest,
  approvalId: string
): Promise<Response> {
  return (
    (await recordContact(context, sessionId, input)) ??
    (await recordProof(context, sessionId, input)) ??
    startChange(
      context.env,
      context.kit,
      context.owner,
      input.text,
      approvalId,
      input.change_kind,
      input.label
    )
  )
}

/** The owner's change, started as `/changes` starts it, keyed by the approval. */
export async function requestChange(
  context: ToolContext,
  input: CosChangeRequest,
  approvalId: string,
  turn: Turn
): Promise<RequestChangeOutput> {
  const response = await startOwnerChange(
    context,
    turn.sessionId,
    input,
    approvalId
  )
  if (!response.ok) return refused(response)
  return RequestChangeOutput.parse({
    outcome: "started",
    build: BuildSummary.parse(await response.json()),
  })
}

const noQuestion = () =>
  failure(404, {
    class: "resource",
    code: "request.not_found",
    message: "No build asked that question.",
    detail: {},
  })

const answerInvalid = () =>
  failure(400, {
    class: "validation",
    code: "answer.invalid",
    message: "That answer does not fit the question.",
    detail: {},
  })

const notOwners = () =>
  failure(400, {
    class: "validation",
    code: "answer.not_owners",
    message:
      "Answer only with what the owner wrote in this conversation, in their words, or the number or address they typed. Otherwise leave the question on its card for them.",
    detail: {},
  })

/**
 * Whether the answer is the owner's own word in `said`: text as `statedIn`
 * reads a claim, a phone number or email address as they typed it, and the
 * other parts of a fact's value all as words or figures of one message. So
 * an answer the model made up, pieced together, or lifted from a page or a
 * review never becomes a fact. Text with no words of its own proves nothing.
 */
export function ownersAnswer(
  value: AnswerQuestionInput["value"],
  said: readonly string[]
): boolean {
  const stated = (text: string, message: string) =>
    contentWords(text).length > 0 && statedIn(text, message)
  if (typeof value === "string") return said.some((m) => stated(value, m))
  const all = said.join("\n")
  if (value.key === "business.phone")
    return phoneFromOwner(value.value.e164, all)
  if (value.key === "business.email") {
    return emailFromOwner(value.value.address, all)
  }
  const parts = Object.values(value.value).flat().map(String)
  return (
    parts.length > 0 && said.some((m) => parts.every((part) => stated(part, m)))
  )
}

const reviewElsewhere = () =>
  failure(400, {
    class: "validation",
    code: "answer.review",
    message:
      "A review is recorded with record_review, once the owner confirms the customer agreed to be quoted.",
    detail: {},
  })

/**
 * The owner's answer, taken from what they said in the chat with no card to
 * approve it (their words are their yes), sent through the orchestrator's
 * `/answer` under `key`, and written onto the chat's card for the question
 * so it folds. The id is looked up only to find the build that asked, which
 * the bridge's path needs; an id the org never asked, another org's
 * included, is refused here and never reaches the orchestrator. Which
 * question may be answered is the orchestrator's to say, as on the owner's
 * route: it refuses any but the one the build waits on. A retry is replayed
 * by what it says, not by its key: the same request id with the same value
 * gets the stored receipt, even after the build has moved on to a newer
 * question, and another value gets 409 `answer.already_given`. `key`
 * goes as the idempotency key, for the bridge's own logs.
 *
 * The value goes as the orchestrator reads it for the question's field: a
 * fact's inner value, for a fact the question names, or the owner's text.
 * A fact for another key, or text for a fact, is refused here.
 *
 * ponytail: the lookup scans the org's `information.requested` events; a
 * partial expression index on `(org_id, payload->>'request_id') where type =
 * 'information.requested'` when that scan shows in the slow log.
 */
export async function answerQuestion(
  { env, kit, owner, settleCard }: ToolContext,
  input: AnswerQuestionInput,
  key: string,
  turn: Pick<Turn, "sessionId">
): Promise<AnswerQuestionOutput> {
  const [asked] = await kit.withOrg({ orgId: owner.orgId }, (db) =>
    db
      .select({
        assignmentId: events.assignmentId,
        field: sql<string>`${events.payload}->>'field'`,
      })
      .from(events)
      .where(
        sql`${events.type} = 'information.requested' and ${events.payload}->>'request_id' = ${input.request_id}`
      )
      .limit(1)
  )
  if (!asked?.assignmentId) return refused(noQuestion())
  const { value } = input
  const fact = typeof value === "object" ? value : null
  const wantsFact = FactValueKey.safeParse(asked.field).success
  if (wantsFact ? fact?.key !== asked.field : fact !== null) {
    return refused(answerInvalid())
  }
  // A review goes only through `record_review`, whose card asks the owner
  // whether the customer agreed to be quoted; an answer card does not.
  if (fact && (REVIEW_FACT_KEYS as readonly string[]).includes(fact.key)) {
    return refused(reviewElsewhere())
  }
  if (!ownersAnswer(value, await ownerSaid({ kit, owner }, turn.sessionId))) {
    return refused(notOwners())
  }
  const answered = relay(
    await bridge(env, owner, `/${asked.assignmentId}/answer`, {
      body: { request_id: input.request_id, value: fact ? fact.value : value },
      key,
    }),
    InformationAnswer.parse
  )
  if (!answered.ok) return refused(answered)
  const receipt = InformationAnswer.parse(await answered.json())
  // The card asking it folds as answered. The build has its answer already,
  // so a card that cannot be written is logged and never fails the tool.
  await kit
    .withOrg({ orgId: owner.orgId }, (db) =>
      settleCard(db, input.request_id, {
        kind: "value",
        value: fact ? fact.value : (value as string),
      })
    )
    .catch((error: unknown) =>
      console.error(
        JSON.stringify({
          code: "cos.question_card_failed",
          error: failureCode(error),
        })
      )
    )
  return { outcome: "answered", request_id: receipt.request_id }
}

/**
 * The owner's reminder, stored as `POST /reminders` stores it, with the
 * turn's conversation and the CoS as its maker. Keyed `approval:<id>`: the
 * owner's own route shares the org's key space and can see approval ids,
 * so a bare id could replay an owner's row here. `due_at` is read as the
 * owner's wall time in the turn's zone (`wallToUtc`). A refusal is the 400
 * `createReminder` answers; a database error leaves the outcome unknown.
 */
export async function createReminder(
  { env, kit, owner }: ToolContext,
  input: CreateReminderRequest,
  approvalId: string,
  turn: Turn,
  zone: string | null
): Promise<CreateReminderOutput> {
  const due = input.due_at === null ? null : wallToUtc(input.due_at, zone)
  let made: Awaited<ReturnType<typeof storeReminder>>
  try {
    made = await kit.withOrg({ orgId: owner.orgId }, (db) =>
      storeReminder(
        db,
        {
          orgId: owner.orgId,
          createdByStaffId: turn.staffId,
          source: "assistant",
          conversationId: turn.sessionId,
          idempotencyKey: `${ASSISTANT_KEY_PREFIX}${approvalId}`,
        },
        { ...input, due_at: due }
      )
    )
  } catch (error) {
    console.error(
      JSON.stringify({ code: "cos.reminder_failed", error: failureCode(error) })
    )
    throw new ToolFailed(503, {
      class: "transient",
      code: "reminder.unconfirmed",
      message: "The reminder could not be confirmed.",
    })
  }
  if (made instanceof Response) return refused(made)
  await wakeScheduler(env, made)
  return { outcome: "created", due_at: made.due_at }
}

/**
 * A customer's review, stored as the owner's `testimonials.review_<slot>`
 * fact, replacing the review in that slot. It runs only after the owner said
 * yes on the card that asks whether the customer agreed to be quoted, and the
 * contract holds `permission` to true. A replay under the same approval
 * restates the same value, which `stateFacts` skips; a database error leaves
 * the outcome unknown.
 */
export async function recordReview(
  { kit, owner }: ToolContext,
  { slot, ...value }: RecordReviewInput
): Promise<RecordReviewOutput> {
  const key: ReviewFactKey = `testimonials.review_${slot}`
  try {
    await kit.withOrg(
      { orgId: owner.orgId, workosUserId: owner.session.workosUserId },
      (db) => stateFacts(db, owner, [{ key, value }])
    )
  } catch (error) {
    console.error(
      JSON.stringify({ code: "cos.review_failed", error: failureCode(error) })
    )
    throw new ToolFailed(503, {
      class: "transient",
      code: "review.unconfirmed",
      message: "The review could not be confirmed.",
    })
  }
  return { outcome: "recorded", slot }
}

const noDomain = () =>
  failure(404, {
    class: "resource",
    code: "domain.not_found",
    message: "No domain with that name is connected to this business.",
    detail: {},
  })

/** An orchestrator domain answer as the model reads it: the output, or the closed refusal. */
export async function domainAnswer<T>(
  result: Bridged,
  parse: (body: unknown) => T
): Promise<T | Refused> {
  const answered = relay(result, parse)
  if (!answered.ok) return refused(answered)
  return parse(await answered.json())
}

/**
 * Where a connected domain is now. It wakes the domain's workflow to look
 * at once, so the orchestrator answers. A name this org does not hold,
 * another org's included, is refused here and never reaches it.
 */
export async function checkDomain(
  { env, kit, owner }: ToolContext,
  { name }: CheckDomainInput
): Promise<CheckDomainOutput> {
  const [held] = await kit.withOrg({ orgId: owner.orgId }, (db) =>
    db
      .select({ id: domains.id })
      .from(domains)
      .where(sql`${eq(domains.name, name)} and ${live}`)
  )
  if (!held) return refused(noDomain())
  return domainAnswer(
    await bridge(env, owner, `/domains/${name}/check`),
    CheckDomainOutput.parse
  )
}

/**
 * What a name the owner says they have is, read before anything is
 * connected: whether it is registered, with whom, who runs its DNS and
 * whether it already points somewhere. Public registry and DNS reads only,
 * through the orchestrator, so no card.
 */
export async function inspectDomain(
  { env, owner }: ToolContext,
  { name }: InspectDomainInput
): Promise<InspectDomainOutput> {
  const answered = relay(
    await bridge(env, owner, `/domains/${name}/inspect`, { method: "GET" }),
    DomainInspection.parse
  )
  if (!answered.ok) return refused(answered)
  // The route answers the bare inspection; the tool's output is tagged.
  return {
    outcome: "inspected",
    ...DomainInspection.parse(await answered.json()),
  }
}

/** The orchestrator's connect answers that a second look a moment later can turn into records. */
const PASSING = new Set(["dns.unavailable", "domain.records_pending"])

/** The pause before that second look, inside the turn's budget. */
export const CONNECT_RETRY_MS = 2_000

/**
 * The owner's existing domain, connected through the orchestrator's
 * `/domains`, keyed by the approval: it starts the domain's workflow once
 * and replays its answer. Whether the name may be claimed (`domain.in_use`,
 * `domain.too_many_pending`, `domain.invalid`) is the orchestrator's to say.
 * A passing 503 is asked once more under the same key, so one approval
 * survives one blip; a second one stands.
 */
export async function connectDomain(
  { env, owner }: ToolContext,
  { name }: ConnectDomainInput,
  approvalId: string
): Promise<ConnectDomainOutput> {
  const ask = () =>
    bridge(env, owner, "/domains", {
      body: { name, approval_id: approvalId },
      key: approvalId,
    })
  let result = await ask()
  if (
    result.status === 503 &&
    PASSING.has(ErrorEnvelope.safeParse(result.body).data?.code ?? "")
  ) {
    await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS))
    result = await ask()
  }
  return domainAnswer(result, ConnectDomainOutput.parse)
}

/**
 * What the owner last typed in `sessionId`, or null when there is none or it
 * was an emailed reply (`eml_`): that crosses a channel the owner does not
 * see, so it is never a yes. Read from the log, not from the model's
 * `messages`, so a context note or a summary can never stand for the owner.
 */
async function typedByOwner(
  { kit, owner }: Pick<ToolContext, "kit" | "owner">,
  sessionId: string
): Promise<string | null> {
  const log = await kit.withOrg({ orgId: owner.orgId }, (db) =>
    readSession(db, sessionId)
  )
  const last = log
    .flatMap((e) => {
      const m =
        e.type === "cos.message" ? CosMessage.safeParse(e.payload) : null
      return m?.success && m.data.message.role === "user"
        ? [m.data.message]
        : []
    })
    .at(-1)
  if (!last || last.id.startsWith("eml_")) return null
  return last.parts
    .flatMap((p) =>
      p.type === "text" && typeof p.text === "string" ? [p.text] : []
    )
    .join("\n")
}

/**
 * Whether a connect (`connect_domain` or `domain_bought`) was already
 * proposed since the owner's last message, whatever came of it. A no, a
 * refusal or a run is the end of that message's yes.
 */
const connectProposed = (messages: readonly ModelMessage[]) =>
  messages
    .slice(messages.map((m) => m.role).lastIndexOf("user"))
    .some(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        m.content.some(
          (p) =>
            p.type === "tool-call" &&
            (p.toolName === "connect_domain" || p.toolName === "domain_bought")
        )
    )

/** Whether the org already has `name` live: connecting it again moves live DNS. */
async function isLive(
  { kit, owner }: Pick<ToolContext, "kit" | "owner">,
  name: string
): Promise<boolean> {
  const [active] = await kit.withOrg({ orgId: owner.orgId }, (db) =>
    db
      .select({ id: domains.id })
      .from(domains)
      .where(sql`${eq(domains.name, name)} and ${domains.state} = 'active'`)
  )
  return Boolean(active)
}

/**
 * Whether connecting `name` still asks on a card. It does not when the
 * owner's last typed message puts the site on exactly that name (Jev, at
 * `sure`). It always does for a name the org already has live, since
 * connecting moves live DNS, and for anything unsure: no key, a message
 * without the name, a Jev error. A connect already proposed since that
 * message (declined, refused or run) never skips the card again, so a no
 * cannot be retried past.
 */
export async function connectApproval(
  { env, kit, owner }: Pick<ToolContext, "env" | "kit" | "owner">,
  { name }: ConnectDomainInput,
  sessionId: string,
  messages: readonly ModelMessage[],
  fetchImpl?: typeof fetch
): Promise<"user-approval" | "not-applicable"> {
  if (!env.OPENROUTER_API_KEY || connectProposed(messages)) {
    return "user-approval"
  }
  const said = await typedByOwner({ kit, owner }, sessionId)
  if (said === null || (await isLive({ kit, owner }, name))) {
    return "user-approval"
  }
  return (await jevPutOn(env.OPENROUTER_API_KEY, said, name, fetchImpl))
    ? "not-applicable"
    : "user-approval"
}

/**
 * Whether the owner's last typed message says they bought `name`, the
 * domain the address task is waiting on them to buy, and Jev is sure it
 * does. The connect this starts has the owner's word as its only consent, so
 * any doubt is a no, and so is a name the org has live or a connect already
 * proposed since that message, as for `connectApproval`. A domain they bought
 * without us offering it goes through `connect_domain` instead.
 */
export async function boughtSaid(
  { env, kit, owner }: Pick<ToolContext, "env" | "kit" | "owner">,
  name: string,
  sessionId: string,
  messages: readonly ModelMessage[],
  fetchImpl?: typeof fetch
): Promise<boolean> {
  if (!env.OPENROUTER_API_KEY || connectProposed(messages)) return false
  const said = await typedByOwner({ kit, owner }, sessionId)
  if (said === null || (await isLive({ kit, owner }, name))) return false
  const address = (await kit.withOrg({ orgId: owner.orgId }, readTasks)).find(
    (t) => t.kind === "address"
  )
  const waiting =
    address?.kind === "address" &&
    address.detail.name === name &&
    address.detail.origin === "buying_elsewhere" &&
    address.steps.some((s) => s.step === "purchase" && s.state !== "done")
  return waiting && jevBought(env.OPENROUTER_API_KEY, said, name, fetchImpl)
}

const unconfirmed = () =>
  failure(409, {
    class: "validation",
    code: "domain.bought_unconfirmed",
    message:
      "The owner has not said they bought this domain, or it is not one they are buying. Ask them which domain they bought.",
    detail: {},
  })

/**
 * The owner saying they bought `name` themselves: the orchestrator asks the
 * registry, wakes the purchase hold and, once the registry shows the name,
 * starts the connect with the owner's word as its consent. So it runs only on
 * the owner's own typed message, read by Jev against the waiting purchase;
 * the owner alone, as buying is.
 */
export async function domainBought(
  { env, kit, owner }: ToolContext,
  { name }: DomainBoughtInput,
  key: string,
  turn: Turn,
  _zone: string | null = null,
  messages: readonly ModelMessage[] = []
): Promise<BoughtElsewhereOutput | Refused> {
  if (!(await isOrgOwner(kit, owner))) return refused(notOwner("buy"))
  if (
    !(await boughtSaid({ env, kit, owner }, name, turn.sessionId, messages))
  ) {
    return refused(unconfirmed())
  }
  return domainAnswer(
    await bridge(env, owner, "/domains/bought", { body: { name }, key }),
    BoughtElsewhereOutput.parse
  )
}

/**
 * The org's removal of a connected domain, for the owner's route and the
 * CoS tool alike: the org's owner only, checked as account deletion checks
 * it, then the orchestrator's `DELETE /domains/{name}` (`remove` in
 * domain-flow.ts), which answers 204. `name` is a path segment as given.
 */
export async function removal(
  { env, kit, owner }: Pick<ToolContext, "env" | "kit" | "owner">,
  name: string,
  key: string
): Promise<Response> {
  if (!(await isOrgOwner(kit, owner))) return notOwner("remove")
  const result = await bridge(env, owner, `/domains/${name}`, {
    method: "DELETE",
    key,
  })
  if (result.status === 204) return new Response(null, { status: 204 })
  return relay(result, () => {
    throw new Error("a removal answers 204 and no body")
  })
}

/**
 * An offer the owner said not now to, asked again after `days` (a week when
 * left out). The kind's open task is made if the offer came before it, then
 * set to `later`, so the same row comes back as the offer it was. Only the
 * owner's words move it, and the owner can start it again whenever they ask.
 */
export async function putOff(
  { kit, owner }: Pick<ToolContext, "kit" | "owner">,
  { kind, days = 7 }: PutOffInput
): Promise<PutOffOutput> {
  const until = new Date(Date.now() + days * 86_400_000).toISOString()
  await kit.withOrg({ orgId: owner.orgId }, async (db) => {
    await openTask(db, owner.orgId, kind)
    await db.execute(sql`
      update owner_tasks set state = 'later', later_until = ${until}::timestamptz
      where kind = ${kind}::task_kind and state in ('active', 'later')`)
  })
  return { outcome: "put_off", until }
}

/** A connected domain taken off the site once the owner said yes, keyed by the approval. */
export async function removeDomain(
  context: ToolContext,
  { name }: RemoveDomainInput,
  approvalId: string
): Promise<RemoveDomainOutput> {
  const answered = await removal(context, name, approvalId)
  if (!answered.ok) return refused(answered)
  return { outcome: "removed" }
}

/**
 * Names free to register now, at the price table's price: the
 * orchestrator's registrar search, which keeps only what the configured
 * registrar reports registrable under the table's cost cap. It costs
 * nothing and reserves nothing, so it needs no approval.
 */
export async function findDomain(
  { env, owner }: ToolContext,
  input: FindDomainInput
): Promise<FindDomainOutput> {
  return domainAnswer(
    await bridge(env, owner, "/domains/find", { body: input }),
    FindDomainOutput.parse
  )
}

/**
 * A purchase prepared and nothing charged: the orchestrator rechecks the
 * name and its price and holds it as `awaiting_payment`, keyed by the tool
 * call, so a rerun replays it. It takes no approval: the owner's payment in
 * the card's Checkout is the consent, and the amount there comes from the
 * row's price. The owner only, and only once this Worker can take payments.
 */
export async function buyDomain(
  { env, kit, owner }: ToolContext,
  input: BuyDomainInput,
  key: string
): Promise<BuyDomainOutput> {
  if (!buyConfigured(env)) return refused(buyUnavailable())
  if (!(await isOrgOwner(kit, owner))) return refused(notOwner("buy"))
  return domainAnswer(
    await bridge(env, owner, "/domains/buy", { body: input, key }),
    BuyDomainOutput.parse
  )
}
