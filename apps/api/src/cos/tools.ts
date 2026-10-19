import {
  type AnswerQuestionInput,
  type AnswerQuestionOutput,
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
  DomainCheck,
  ErrorEnvelope,
  type FactRecord,
  FactValue,
  FactValueKey,
  type FindDomainInput,
  FindDomainOutput,
  type GetPreviewInput,
  GetPreviewOutput,
  InformationAnswer,
  OwnerAnswerText,
  PreviewLink,
  REVIEW_FACT_KEYS,
  type RecordReviewInput,
  type RecordReviewOutput,
  type RemoveDomainInput,
  type RemoveDomainOutput,
  RequestChangeOutput,
  type ReviewFactKey,
} from "@workspace/contracts"
import {
  assignments,
  domains,
  eq,
  events,
  failureCode,
  siteRevisions,
  sql,
  type Tenancy,
} from "@workspace/db"
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
import {
  ASSISTANT_KEY_PREFIX,
  createReminder as storeReminder,
  wakeScheduler,
} from "../reminders.ts"
import { readFacts, readWorkspace } from "../workspace.ts"
import { readSession } from "./history.ts"
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

export type ToolContext = { env: Env; kit: Tenancy; owner: Owner }

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

export async function getWorkspace(
  { env, kit, owner }: ToolContext,
  _input: Empty
): Promise<CosWorkspace> {
  const status = await readWorkspace(kit, owner.orgId, env)
  const rows = await kit.withOrg({ orgId: owner.orgId }, (db) =>
    db
      .select({
        name: domains.name,
        state: domains.state,
        lastCheck: domains.lastCheck,
      })
      .from(domains)
      .where(live)
      .orderBy(sql`${domains.createdAt} desc`)
      .limit(10)
  )
  return CosWorkspace.parse({
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
    })),
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
    expected_seconds: status.expected_seconds,
  })
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

const untyped = (what: string) =>
  failure(400, {
    class: "validation",
    code: "contact.not_typed",
    message: `That ${what} is not one the owner typed in this conversation, or the change text does not name it. Name it in the change, as the owner typed it, then propose again.`,
    detail: {},
  })

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
  { contact, text }: CosChangeRequest
): Promise<Response | null> {
  if (!contact?.phone && !contact?.email) return null
  const log = await kit.withOrg({ orgId: owner.orgId }, (db) =>
    readSession(db, sessionId)
  )
  const said = log
    .flatMap((e) => {
      const m =
        e.type === "cos.message" ? CosMessage.safeParse(e.payload) : null
      return m?.success && m.data.message.role === "user"
        ? m.data.message.parts.flatMap((p) =>
            p.type === "text" ? [p.text] : []
          )
        : []
    })
    .join("\n")
  const stated: FactValue[] = []
  if (contact.phone) {
    if (
      !(
        phoneFromOwner(contact.phone, said) &&
        phoneFromOwner(contact.phone, text)
      )
    )
      return untyped("phone number")
    stated.push({ key: "business.phone", value: { e164: contact.phone } })
  }
  if (contact.email) {
    if (
      !(
        emailFromOwner(contact.email, said) &&
        emailFromOwner(contact.email, text)
      )
    )
      return untyped("email address")
    stated.push({ key: "business.email", value: { address: contact.email } })
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

/**
 * The owner's change, started as `/changes` starts it, keyed by the
 * approval, after any contact detail in it is recorded. Both ways a yes
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
    startChange(
      context.env,
      context.kit,
      context.owner,
      input.text,
      approvalId,
      input.change_kind
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

const reviewElsewhere = () =>
  failure(400, {
    class: "validation",
    code: "answer.review",
    message:
      "A review is recorded with record_review, once the owner confirms the customer agreed to be quoted.",
    detail: {},
  })

/**
 * The owner's answer, sent through the orchestrator's `/answer` keyed by the
 * approval. The id is looked up only to find the build that asked, which
 * the bridge's path needs; an id the org never asked, another org's
 * included, is refused here and never reaches the orchestrator. Which
 * question may be answered is the orchestrator's to say, as on the owner's
 * route: it refuses any but the one the build waits on. A retry is replayed
 * by what it says, not by its key: the same request id with the same value
 * gets the stored receipt, even after the build has moved on to a newer
 * question, and another value gets 409 `answer.already_given`. The approval
 * id still goes as the idempotency key, for the bridge's own logs.
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
  { env, kit, owner }: ToolContext,
  input: AnswerQuestionInput,
  approvalId: string
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
  const answered = relay(
    await bridge(env, owner, `/${asked.assignmentId}/answer`, {
      body: { request_id: input.request_id, value: fact ? fact.value : value },
      key: approvalId,
    }),
    InformationAnswer.parse
  )
  if (!answered.ok) return refused(answered)
  const receipt = InformationAnswer.parse(await answered.json())
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
 * The org's removal of a connected domain, for the owner's route and the
 * CoS tool alike: the org's owner only, checked as account deletion checks
 * it, then the orchestrator's `DELETE /domains/{name}` (`remove` in
 * domain-flow.ts), which answers 204. `name` is a path segment as given.
 */
export async function removal(
  { env, kit, owner }: ToolContext,
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
