import {
  BuildSummary,
  ChatRequest,
  type ChatResult,
  type CosTurn,
  ErrorEnvelope,
  type FactRecord,
  OnboardingPlan,
  RequestChangeOutput,
  TOOL_CALL_CANCELLED,
} from "@workspace/contracts"
import {
  chiefStaffId,
  conversationMessages,
  conversations,
  eq,
  events,
  newUlid,
  type OrgScopedDb,
  orgs,
  sql,
  type Tenancy,
} from "@workspace/db"
import {
  type LanguageModel,
  UI_MESSAGE_STREAM_HEADERS,
  type UIMessage,
  type UIMessageChunk,
} from "ai"
import { type Owner, startChange, stateFacts } from "./changes.ts"
import { holdsNul, notFound } from "./conversations.ts"
import {
  type AgentTurn,
  activeTools,
  contextOf,
  cosPrefix,
  DEFAULT_MODEL,
  knownZone,
  LIMITS,
  messageTaint,
  newRunState,
  openrouterModel,
  personaOf,
  priceOf,
  reservation,
} from "./cos/agent.ts"
import {
  CONTEXT_POLICY,
  deriveCosMessages,
  readSession,
  sha256,
} from "./cos/history.ts"
import {
  closeTurn,
  type FellBack,
  type Rows,
  ranTurn,
  settle,
  streamTurn,
} from "./cos/run.ts"
import { getWorkspace, type ToolFailed } from "./cos/tools.ts"
import {
  beginTurn,
  closeLapsedTurn,
  loggedMessage,
  NoSuchSession,
  type Opening,
  SessionBusy,
  type SessionState,
  sessionState,
  type Turn,
  withinCap,
  writeAsTurn,
} from "./cos/turns.ts"
import {
  failure,
  invalid,
  readBody,
  sortedKeys,
  titleFrom,
  withoutProviderData,
} from "./http.ts"
import {
  type Answer,
  again,
  buildCall,
  built,
  cardAnswer,
  factValue,
  isCard,
  ONBOARDING_GOAL,
  type Onboarding,
  OUTPUTS,
  onboardingStep,
  opening as openingParts,
  type Progress,
  progressOf,
  type ScriptRow,
  ended as scriptEnded,
  text as textPart,
  typedAnswer,
  voiceOf,
  applied as withAnswer,
} from "./onboarding.ts"
import {
  askedSoFar,
  checkPlan,
  DEFAULT_ONBOARDING_MODEL,
  PLANNER,
  PLANNER_VERSION,
  type PlanCall,
  type PlanInput,
  type PlanOutcome,
  type Row as PlanRow,
  type PlanState,
  plannerModel,
  plannerPrefix,
  planParts,
  planReservation,
  planTurn,
  turnData,
} from "./onboarding-agent.ts"
import { notStarted } from "./onboarding-copy.ts"
import { ownerStaffId } from "./staff.ts"
import { readFacts } from "./workspace.ts"

/**
 * `POST /chat`: a turn, answered by the Chief of Staff (ADR-034) or by the
 * script. The script owns the onboarding conversation until it has started
 * the first build or the owner chose to build the site themselves, and
 * every results turn on a call it made: it asks each step of
 * `onboarding.ts` with a question and a card (`ask_fact`, `ask_choice` or
 * `ask_upload`), and a typed reply answers the card it overtook. Every
 * other turn goes to the CoS,
 * whose history is the event log; when the CoS has no model, no budget, a
 * frozen conversation or a provider that fails before any content, the
 * script's step stands in for it: a change card in Act mode and one fixed
 * line in Ask.
 *
 * The client sends only what the owner just did (`ChatRequest`). The stored
 * rows are what assistant-ui reads, written in the same transactions as the
 * log, so a reload shows what the stream showed. A continued message is one
 * row that grows: ai 7 continues the last assistant message, so an approval,
 * or an answer sent without the owner's reply, updates that row and never
 * appends a second one. An answer sent with the owner's reply is a message of
 * theirs, as a typed one is: it and the next step each get a row, so every
 * onboarding step is a message of its own.
 */

export { ONBOARDING_GOAL }

/** Ask mode's one line when the Chief of Staff cannot answer: the script's, or the fallback's. */
export const ASK_REPLY =
  "I can't answer right now. Try again in a moment, or switch to Act and tell me what to change on your site."

/** assistant-ui's words when a new message cancels a pending call, so a reload matches. */
export const CANCELLED = TOOL_CALL_CANCELLED

/** `format` on every row: `aiSDKV6FormatAdapter.format`, v6 even on ai 7. */
const FORMAT = "ai-sdk/v6"

export type ToolPart = {
  type:
    | "tool-ask_fact"
    | "tool-ask_choice"
    | "tool-ask_upload"
    | "tool-review_quote_form"
    | "tool-request_change"
  toolCallId: string
  state:
    | "input-available"
    | "approval-requested"
    | "output-available"
    | "output-denied"
    | "output-error"
  input: unknown
  output?: unknown
  errorText?: string
  approval?: { id: string; approved?: boolean }
}
export type Part =
  | { type: "step-start" }
  | { type: "text"; text: string; state: "done" }
  | ToolPart
type Content = { role: "user" | "assistant"; parts: Part[] }

const isTool = (part: Part): part is ToolPart => part.type.startsWith("tool-")
const pending = (part: ToolPart) =>
  part.state === "input-available" || part.state === "approval-requested"

export type Script = {
  /** The onboarding script's state while it runs, or null once it has ended or elsewhere. */
  onboarding: Onboarding | null
  /** A typed message, or null when a resolved call asks what comes next. */
  message: { mode: "ask" | "act"; text: string } | null
  newId: () => string
}

/**
 * The next step's parts. Pure: the same input and ids give the same parts.
 * While onboarding runs, its next step; after it, an Ask message is one
 * fixed line and an Act message a change card.
 */
export function nextStep(s: Script): Part[] {
  if (s.onboarding) return onboardingStep(s.onboarding, s.newId)
  if (!s.message) return []
  if (s.message.mode === "ask") {
    return [{ type: "text", text: ASK_REPLY, state: "done" }]
  }
  return [changeCall(s.message.text, s.newId)]
}

const changeCall = (text: string, newId: () => string): ToolPart => ({
  type: "tool-request_change",
  toolCallId: newId(),
  state: "approval-requested",
  input: { text },
  approval: { id: newId() },
})

/** The chunks that put a part on screen as it was first made. */
function made(part: Part): UIMessageChunk[] {
  if (part.type === "step-start") return [{ type: "start-step" }]
  if (part.type === "text") {
    return [
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: part.text },
      { type: "text-end", id: "text" },
    ]
  }
  const { toolCallId } = part
  const call: UIMessageChunk[] = [
    {
      type: "tool-input-available",
      toolCallId,
      toolName: part.type.slice("tool-".length),
      input: part.input,
    },
  ]
  if (part.approval) {
    call.push({
      type: "tool-approval-request",
      approvalId: part.approval.id,
      toolCallId,
    })
  }
  // A call the script made already answered, such as the build it started.
  return pending(part) ? call : [...call, ...resolved(part)]
}

/** The chunks that move a pending call to how it was resolved. */
function resolved(part: ToolPart): UIMessageChunk[] {
  const { toolCallId, approval } = part
  const response: UIMessageChunk[] = approval
    ? [
        {
          type: "tool-approval-response",
          approvalId: approval.id,
          approved: part.state === "output-available",
        },
      ]
    : []
  if (part.state === "output-denied") {
    return [...response, { type: "tool-output-denied", toolCallId }]
  }
  return [
    ...response,
    { type: "tool-output-available", toolCallId, output: part.output },
  ]
}

/**
 * The response: every chunk as an SSE frame, then `[DONE]`. A continuation
 * resolves `call` and opens a new step, so the tool-calls predicate never
 * sees a finished call as the last step and sends again.
 */
function stream(
  messageId: string,
  step: Part[],
  lead: UIMessageChunk[] = []
): Response {
  const chunks: UIMessageChunk[] = [
    { type: "start", messageId },
    { type: "start-step" },
    ...lead,
    ...step.flatMap(made),
    { type: "finish-step" },
    { type: "finish" },
  ]
  const frames = chunks.map(
    (chunk) => `data: ${JSON.stringify(chunk, sortedKeys)}\n\n`
  )
  return new Response(`${frames.join("")}data: [DONE]\n\n`, {
    headers: UI_MESSAGE_STREAM_HEADERS,
  })
}

/** The step that followed `call` in the stored row, as it was first made. */
function stepAfter(parts: Part[], call: ToolPart): Part[] {
  const opened = parts.indexOf(call) + 1
  const start = parts.findIndex(
    (p, i) => i >= opened && p.type === "step-start"
  )
  if (start < 0) return []
  const end = parts.findIndex((p, i) => i > start && p.type === "step-start")
  return parts.slice(start + 1, end < 0 ? undefined : end)
}

const stale = () =>
  failure(409, {
    class: "validation",
    code: "chat.stale",
    message: "This conversation has moved on. Reload it.",
    detail: {},
  })

const answerInvalid = () =>
  failure(400, {
    class: "validation",
    code: "chat.answer_invalid",
    message: "That answer does not fit the question.",
    detail: {},
  })

type Row = typeof conversationMessages.$inferSelect
type Tail = Row & { content: Content }
type Read = { kind: "onboarding" | "assistant"; tail: Tail | null }

/**
 * The conversation under the session's org and its last row, with the
 * turn's lock held for the rest of the transaction so turns on it run one at
 * a time: 404 for a conversation the org does not hold, and 409 `chat.busy`
 * while another turn has it.
 *
 * The lock is an advisory one only turns take (ADR-034), not the row's: a
 * rename, an archive or a message insert takes the row too, and would make a
 * turn busy with no turn open. The two-key form never meets the one-key site
 * lock. It is tried rather than waited on, so a waiting turn holds no second
 * connection.
 */
async function read(db: OrgScopedDb, id: string): Promise<Read | Response> {
  const [conversation] = await db
    .select({ kind: conversations.kind })
    .from(conversations)
    .where(eq(conversations.id, id))
  if (!conversation) return notFound()
  const [turn] = await db.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(2, hashtext(${id}::text)) as locked`
  )
  if (!turn?.locked) return busy()
  return { kind: conversation.kind, tail: await readTail(db, id) }
}

const busy = () =>
  failure(409, {
    class: "validation",
    code: "chat.busy",
    message: "I'm still working on your last message. Try again in a moment.",
    detail: {},
  })

async function readTail(db: OrgScopedDb, id: string): Promise<Tail | null> {
  const [tail] = await db
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, id))
    .orderBy(sql`${conversationMessages.seq} desc`)
    .limit(1)
  return (tail as Tail | undefined) ?? null
}

/**
 * What the script reads from an onboarding conversation: every card it
 * made, how each was resolved, and the owner's typed message for a card one
 * overtook (`progressOf` reads them). A build offer talked over by a typed
 * message was cancelled, not made, so it does not count.
 */
export async function readScript(
  db: OrgScopedDb,
  id: string
): Promise<Progress> {
  const rows = await db.execute<ScriptRow>(
    sql`select
      p->>'type' as type,
      p->>'state' as state,
      coalesce(p->'input'->>'key', p->'input'->>'step') as step,
      p->'output'->>'answer' as answer,
      p->'output'->'ids'->>0 as choice,
      case when p->>'state' = 'output-error' then (
        select u.content->'parts'->0->>'text' from ${conversationMessages} u
        where u.conversation_id = m.conversation_id and u.parent_id = m.id and u.content->>'role' = 'user'
        limit 1
      ) end as reply
    from ${conversationMessages} m, jsonb_array_elements(m.content->'parts') p
    where m.conversation_id = ${id} and m.content->>'role' = 'assistant' and p->>'type' like 'tool-%'
    order by m.seq`
  )
  return progressOf([...rows])
}

/**
 * The onboarding script's state for this turn, or null when the
 * conversation is not onboarding or the script has ended there.
 */
async function onboardingOf(
  db: OrgScopedDb,
  held: Read,
  id: string,
  owner: Owner
): Promise<Onboarding | null> {
  if (held.kind !== "onboarding") return null
  const progress = await readScript(db, id)
  if (scriptEnded(progress)) return null
  const facts = await readFacts(db)
  const [org] = await db.select({ name: orgs.name }).from(orgs).limit(1)
  return {
    ...progress,
    orgId: owner.orgId,
    facts,
    orgName: org?.name ?? "",
    ownerName: owner.session.name ?? "",
    ownerEmail: owner.session.email,
  }
}

/**
 * Swaps the tail row's content, only while it is still what was read, and
 * moves the conversation up the list. False when another turn got there first.
 */
async function swapTail(
  db: OrgScopedDb,
  conversationId: string,
  tail: Row,
  content: Content
): Promise<boolean> {
  const swapped = await db
    .update(conversationMessages)
    .set({ content })
    .where(
      sql`${conversationMessages.conversationId} = ${conversationId} and ${conversationMessages.id} = ${tail.id} and ${conversationMessages.content} = ${JSON.stringify(tail.content)}::jsonb`
    )
    .returning({ id: conversationMessages.id })
  if (swapped.length === 0) return false
  await db
    .update(conversations)
    .set({ updatedAt: sql`now()` })
    .where(eq(conversations.id, conversationId))
  return true
}

/**
 * An assistant conversation's first message names it: a title from the
 * owner's words, written with the message, so a turn refused before its
 * message is stored names nothing. Only a conversation that held no message
 * before this turn is named, never the onboarding one, and only while it
 * has no title, so a rename is never overwritten.
 */
async function nameConversation(
  db: OrgScopedDb,
  held: Read,
  id: string,
  text: string
) {
  if (held.kind !== "assistant" || held.tail !== null) return
  const title = titleFrom(text)
  if (!title) return
  await db
    .update(conversations)
    .set({ title, updatedAt: sql`now()` })
    .where(sql`${conversations.id} = ${id} and ${conversations.title} is null`)
}

/** Thrown inside a turn's transaction to roll it back and answer with this. */
class Refusal {
  constructor(readonly response: Response) {}
}

export type ChatDeps = {
  newId?: () => string
  /**
   * The Chief of Staff's model. Left out, it is OpenRouter's when the api
   * holds a key, and none otherwise, which is the fallback. Tests pass one.
   */
  model?: LanguageModel | null
  /** Where the stream's reader goes after the response: `ctx.waitUntil`. */
  waitUntil?: (promise: Promise<unknown>) => void
  /**
   * The onboarding planner's model, as `model` is the CoS's: left out, it is
   * OpenRouter's `ONBOARDING_MODEL` when the api holds a key. Tests pass one.
   */
  planner?: LanguageModel | null
}

export async function chat(
  request: Request,
  env: Env,
  kit: Tenancy,
  owner: Owner,
  deps: ChatDeps = {}
): Promise<Response> {
  const newId = deps.newId ?? (() => crypto.randomUUID())
  const body = await readBody(request)
  const parsed = ChatRequest.safeParse(body)
  if (!parsed.success) return invalid(parsed.error.issues)
  // Postgres refuses NUL in text and jsonb, and a refusal there is a 500.
  if (holdsNul(parsed.data)) return invalid([{ path: ["turn"] }])
  const { conversation_id: id, mode, turn, time_zone: zone } = parsed.data
  if (zone && !knownZone(zone)) return invalid([{ path: ["time_zone"] }])
  const scope = { orgId: owner.orgId, workosUserId: owner.session.workosUserId }
  const tools = { env, kit, owner }
  // Read before the turn's lock is taken; the CoS's context is built from it.
  const [workspace, prefix] = await Promise.all([
    getWorkspace(tools, {}),
    cosPrefix(),
  ])
  const modelId = env.COS_MODEL ?? DEFAULT_MODEL
  const price = priceOf(modelId)
  const model =
    deps.model !== undefined
      ? deps.model
      : env.OPENROUTER_API_KEY
        ? openrouterModel(env.OPENROUTER_API_KEY, modelId)
        : null
  const plannerId = env.ONBOARDING_MODEL ?? DEFAULT_ONBOARDING_MODEL
  const planPrice = priceOf(plannerId)
  const planner =
    deps.planner !== undefined
      ? deps.planner
      : env.OPENROUTER_API_KEY
        ? plannerModel(env.OPENROUTER_API_KEY, plannerId)
        : null
  let opened: Opened | Response | { plan: PlanJob }
  try {
    opened = await kit.withOrg(scope, async (db) => {
      const held = await read(db, id)
      if (held instanceof Response) return held
      const chiefId = await chiefOf(db, owner)
      const session = chiefId
        ? { orgId: owner.orgId, staffId: chiefId, sessionId: id }
        : null
      // Every turn respects an open CoS turn, the script's included.
      if (session && (await closeLapsedTurn(db, session, LIMITS.totalMs))) {
        return busy()
      }
      const named = turn.kind === "results" ? turn.message_id : held.tail?.id
      const log = session
        ? await sessionState(db, id, prefix.sha256, named ?? null)
        : null
      const scripted =
        !session ||
        !log ||
        (held.kind === "onboarding" &&
          !scriptEnded(await readScript(db, id))) ||
        (turn.kind === "results" && !log.named)
      if (scripted) {
        // Onboarding turns go to the planner when it can run; the script
        // answers the rest, and every turn the planner cannot.
        const job =
          session && log && !log.frozen && planner && planPrice
            ? await openPlan(
                db,
                held,
                id,
                parsed.data,
                owner,
                session,
                planPrice
              )
            : null
        if (job) return { plan: job }
        return scriptTurn(db, env, kit, owner, held, id, parsed.data, newId)
      }
      const reserve = model && price && !log.frozen ? reservation(price) : 0
      const fallback: Fallback | null =
        log.frozen || !model || !price
          ? "resource"
          : (await withinCap(db, owner.orgId, reserve))
            ? null
            : "budgetary"
      const opening = await openCos(db, held, id, parsed.data, log)
      if (opening instanceof Response) return opening
      const cosTurn: Turn = { ...session, turnId: newUlid() }
      const context = contextOf(
        mode,
        workspace,
        zone ?? null,
        new Date(),
        turn.kind === "message" ? parsed.data.intent : undefined,
        personaOf(await readFacts(db))
      )
      await beginTurn(db, cosTurn, {
        prefix: log.prefixLogged ? null : prefix,
        messages: opening.messages,
        context: {
          turn_id: cosTurn.turnId,
          prefix_sha256: prefix.sha256,
          context_policy_version: CONTEXT_POLICY.version,
          mode,
          active_tools: activeTools(mode),
          text: context.text,
          reserved_usd: fallback ? 0 : reserve,
        },
        contextTaint: context.taint,
      })
      if (turn.kind === "message") {
        await putRow(db, owner, id, {
          id: turn.message_id,
          role: "user",
          parts: [{ type: "text", text: turn.text }],
        })
        await nameConversation(db, held, id, turn.text)
      }
      return {
        turn: cosTurn,
        fallback,
        reserved: fallback ? 0 : reserve,
        tail: opening.tail,
      }
    })
  } catch (error) {
    if (error instanceof Refusal) return error.response
    if (error instanceof SessionBusy) return busy()
    if (error instanceof NoSuchSession) return notFound()
    throw error
  }
  if (opened instanceof Response) return opened
  if ("plan" in opened) {
    return planned(opened.plan, {
      env,
      kit,
      owner,
      id,
      request: parsed.data,
      newId,
      model: planner as LanguageModel,
      modelId: plannerId,
      price: planPrice as NonNullable<typeof planPrice>,
    })
  }
  const run: AgentTurn = {
    turn: opened.turn,
    kit,
    tools,
    price: price ?? { input: 0, output: 0, cacheRead: 0 },
    reserved: opened.reserved,
    state: newRunState(),
    abort: new AbortController(),
    zone: zone ?? null,
  }
  return answerCos(run, {
    env,
    owner,
    id,
    mode,
    turn: parsed.data.turn,
    opened,
    model: opened.fallback ? null : model,
    modelId,
    newId,
    waitUntil: deps.waitUntil ?? ((promise) => void promise),
  })
}

/**
 * The org's CoS staff row. An org made before the starting team gets the
 * team here, as a change does (`ownerStaffId` is idempotent). Null only when
 * the row is still missing, which is logged: the script then answers.
 */
async function chiefOf(db: OrgScopedDb, owner: Owner): Promise<string | null> {
  const found = await chiefStaffId(db)
  if (found) return found
  await ownerStaffId(db, {
    orgId: owner.orgId,
    workosUserId: owner.session.workosUserId,
    ownerName: owner.session.name ?? owner.session.email,
  })
  const hired = await chiefStaffId(db)
  if (!hired) console.error(JSON.stringify({ code: "cos.chief_missing" }))
  return hired
}

type Fallback = "provider" | "budgetary" | "resource"

/** What a CoS turn's first transaction hands to the rest of the turn. */
type Opened = {
  turn: Turn
  fallback: Fallback | null
  reserved: number
  /** For a results turn: the message its results resolved. */
  tail: { id: string } | null
}

/** A turn the script answers: everything before the CoS, unchanged. */
function scriptTurn(
  db: OrgScopedDb,
  env: Env,
  kit: Tenancy,
  owner: Owner,
  held: Read,
  id: string,
  { mode, turn }: ChatRequest,
  newId: () => string
): Promise<Response> {
  if (turn.kind === "message") {
    return typed(
      db,
      env,
      kit,
      owner,
      held,
      id,
      { mode, text: turn.text },
      turn.message_id,
      newId
    )
  }
  // The script's steps each wait on one call, so its results turn
  // resolves exactly one; any other set is not what it is waiting on.
  // The script has no model, so an approval's reason is not kept.
  const [result, ...more] = turn.results
  if (!result || more.length > 0) return Promise.resolve(stale())
  const one = { message_id: turn.message_id, ...result }
  if (one.kind === "answer") {
    return answer(db, env, kit, owner, held, id, one, turn.reply, newId)
  }
  return approve(db, env, kit, owner, held, id, one)
}

type CosPart = {
  type: string
  toolCallId?: string
  state?: string
  output?: unknown
  errorText?: string
  approval?: { id: string; approved?: boolean; reason?: string }
}

const DECLINED = "The owner declined"

/** A denial's reason as the model reads it: always the owner's no first. */
const declined = (reason: string | undefined) =>
  reason === undefined ? `${DECLINED}.` : `${DECLINED}: ${reason}`

/** The owner's own words from a reason, as the screen shows them. */
function ownerWords(reason: string | undefined): string | undefined {
  if (reason === `${DECLINED}.`) return undefined
  return reason?.startsWith(`${DECLINED}: `)
    ? reason.slice(DECLINED.length + 2)
    : reason
}

/** The reason the screen shows for an approval: a denial's unframed. */
const shownReason = (approval: { approved?: boolean; reason?: string }) =>
  approval.approved === false ? ownerWords(approval.reason) : approval.reason

/** The chunks that show a CoS call as the owner's results left it. */
function settledChunks(part: CosPart): UIMessageChunk[] {
  const toolCallId = part.toolCallId as string
  const response: UIMessageChunk[] = part.approval
    ? [
        {
          type: "tool-approval-response",
          approvalId: part.approval.id,
          approved: part.approval.approved === true,
          ...(shownReason(part.approval) === undefined
            ? {}
            : { reason: shownReason(part.approval) }),
        },
      ]
    : []
  if (part.state === "output-denied") {
    return [...response, { type: "tool-output-denied", toolCallId }]
  }
  if (part.state === "output-error") {
    return [
      ...response,
      {
        type: "tool-output-error",
        toolCallId,
        errorText: part.errorText ?? "",
      },
    ]
  }
  if (part.state === "output-available") {
    return [
      ...response,
      { type: "tool-output-available", toolCallId, output: part.output },
    ]
  }
  return response
}

/**
 * The CoS side of a turn's first transaction: the messages the turn logs,
 * and the stored rows they change. A typed message cancels the tail's
 * pending calls, as the script's does, and logs the tail again when the
 * CoS made it. A results turn must resolve exactly the pending calls of the
 * tail's last step, each once: an approval is `approval-responded` until
 * its tool runs, a denial is `output-denied`, and a reason is kept.
 */
async function openCos(
  db: OrgScopedDb,
  held: Read,
  id: string,
  { turn }: ChatRequest,
  log: SessionState
): Promise<
  | {
      messages: Opening["messages"]
      tail: { id: string } | null
    }
  | Response
> {
  if (turn.kind === "message") {
    if (await messageTaken(db, id, turn.message_id)) return messageExists()
    const cancelled = await cancelPending(db, id, held.tail)
    const user = {
      id: turn.message_id,
      role: "user" as const,
      parts: [{ type: "text", text: turn.text }],
    }
    // The log keeps the tail's reasoning, which its row leaves out.
    const logged =
      cancelled && log.named && held.tail
        ? await loggedMessage(db, id, held.tail.id)
        : null
    const messages = logged
      ? [{ ...logged, parts: cancelParts(logged.parts) }, user]
      : [user]
    return {
      messages: messages.map((m) => ({ message: m, taint: messageTaint(m) })),
      tail: null,
    }
  }
  const { tail } = held
  if (tail?.id !== turn.message_id || tail.content.role !== "assistant") {
    return stale()
  }
  // Resolved on the logged message, which keeps the reasoning the row leaves out.
  const logged = (await loggedMessage(db, id, tail.id)) ?? {
    id: tail.id,
    role: "assistant" as const,
    parts: tail.content.parts,
  }
  const parts = logged.parts as CosPart[]
  const last = parts.slice(parts.map((p) => p.type).lastIndexOf("step-start"))
  const waiting = last.filter(
    (p) => p.type.startsWith("tool-") && p.state === "approval-requested"
  )
  const results = turn.results
  const byApproval = new Map(
    results.flatMap((r) => (r.kind === "approval" ? [[r.approval_id, r]] : []))
  )
  if (
    results.length !== waiting.length ||
    byApproval.size !== results.length ||
    !waiting.every((p) => p.approval && byApproval.has(p.approval.id))
  ) {
    return stale()
  }
  const applied = parts.map((part): CosPart => {
    const result = part.approval ? byApproval.get(part.approval.id) : undefined
    if (!result || !waiting.includes(part)) return part
    // A denial's reason is the owner's free text, so the model gets it
    // framed as the owner's no; it could otherwise open with words the
    // instructions give to a failure. The screen keeps the owner's words.
    const approval = {
      id: result.approval_id,
      approved: result.approved,
      ...(result.approved
        ? result.reason === undefined
          ? {}
          : { reason: result.reason }
        : { reason: declined(result.reason) }),
    }
    return result.approved
      ? { ...part, state: "approval-responded", approval }
      : { ...part, state: "output-denied", approval }
  })
  const row = { role: "assistant" as const, parts: shown(applied) as Part[] }
  if (!(await swapTail(db, id, tail, row))) throw new Refusal(stale())
  const message = { id: tail.id, role: "assistant" as const, parts: applied }
  return {
    messages: [{ message, taint: messageTaint(message) }],
    tail: message,
  }
}

/**
 * Writes a message's stored row: its content when the row exists, or a new
 * row after the conversation's last one. The conversation moves up the list.
 */
async function putRow(
  db: OrgScopedDb,
  owner: Owner,
  id: string,
  message: { id: string; role: string; parts: unknown[] }
): Promise<void> {
  const content = {
    role: message.role,
    parts: shown(message.parts as { type: string }[]),
  }
  const updated = await db
    .update(conversationMessages)
    .set({ content })
    .where(
      sql`${conversationMessages.conversationId} = ${id} and ${conversationMessages.id} = ${message.id}`
    )
    .returning({ id: conversationMessages.id })
  if (updated.length === 0) {
    const [last] = await db
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, id))
      .orderBy(sql`${conversationMessages.seq} desc`)
      .limit(1)
    await db.insert(conversationMessages).values({
      conversationId: id,
      orgId: owner.orgId,
      format: FORMAT,
      id: message.id,
      parentId: last?.id ?? null,
      content,
    })
  }
  await db
    .update(conversations)
    .set({ updatedAt: sql`now()` })
    .where(eq(conversations.id, id))
}

/** Everything a CoS turn needs after its first transaction. */
type Answering = {
  env: Env
  owner: Owner
  id: string
  mode: "ask" | "act"
  turn: ChatRequest["turn"]
  opened: Opened
  model: LanguageModel | null
  modelId: string
  newId: () => string
  waitUntil: (promise: Promise<unknown>) => void
}

/**
 * The CoS answers an open turn. Approved calls with no result run first,
 * under their approval ids, whether the model or the fallback answers.
 * Then the model streams, or the script's step stands in for it.
 */
async function answerCos(run: AgentTurn, a: Answering): Promise<Response> {
  const rows: Rows = (db, message) => putRow(db, a.owner, a.id, message)
  const ended = (
    outcome: "error" | "integrity" | "fallback",
    reason: Fallback = "resource"
  ): CosTurn => {
    const { outcome: _, ...ran } = ranTurn(run, a.modelId, "answered", null)
    return outcome === "fallback"
      ? { ...ran, outcome, reason }
      : { ...ran, outcome }
  }
  // Anything that throws before a response exists closes the turn as an
  // error, so the next turn need not wait for it to lapse.
  let failed: ToolFailed | null = null
  let streamed: Response | FellBack | null = null
  try {
    failed = await settle(run, rows)
    if (!failed && !a.opened.fallback && a.model) {
      streamed = await startModel(run, a, a.model, rows)
    }
  } catch (error) {
    await closeTurn(run, ended("error"), null, rows).catch(() => undefined)
    throw error
  }
  if (failed) {
    await closeTurn(run, ended("error"), null, rows)
    return failure(failed.status, { ...failed.error, detail: {} })
  }
  if (streamed instanceof Response) return streamed
  if (streamed && run.state.readFailed) {
    await closeTurn(run, ended("error"), null, rows)
    return failure(503, {
      class: "transient",
      code: "cos.read_failed",
      message: "We could not read this conversation. Try again.",
      detail: {},
    })
  }
  if (streamed && run.state.integrity) {
    return fallbackTurn(run, a, rows, ended("integrity"))
  }
  const fallback = streamed
    ? run.state.overBudget
      ? "budgetary"
      : "provider"
    : a.opened.fallback
  return fallbackTurn(run, a, rows, ended("fallback", fallback ?? "resource"))
}

/** The model's run over the history the log derives now. */
async function startModel(
  run: AgentTurn,
  a: Answering,
  model: LanguageModel,
  rows: Rows
): Promise<Response | FellBack> {
  const history = await run.kit.withOrg({ orgId: run.turn.orgId }, (db) =>
    readSession(db, run.turn.sessionId)
  )
  const { messages } = deriveCosMessages(history, CONTEXT_POLICY)
  const tail = a.opened.tail
  return streamTurn({
    run,
    model,
    mode: a.mode,
    modelId: a.modelId,
    uiMessages: messages,
    newMessageId: a.newId,
    lead: tail ? settledLead(messages, tail.id) : [],
    rows,
    waitUntil: a.waitUntil,
  })
}

/** The lead chunks for a results turn: its tail's calls as the log now has them. */
function settledLead(messages: UIMessage[], tailId: string): UIMessageChunk[] {
  const tail = messages.find((m) => m.id === tailId)
  const parts = (tail?.parts ?? []) as CosPart[]
  const last = parts.slice(parts.map((p) => p.type).lastIndexOf("step-start"))
  return last
    .filter(
      (p) => p.type.startsWith("tool-") && p.approval?.approved !== undefined
    )
    .flatMap(settledChunks)
}

/**
 * The turn without the model: the script's step for a typed message, not
 * logged, so the model learns its effect from the next context; for a
 * results turn, the resolved message, logged with no model text.
 */
async function fallbackTurn(
  run: AgentTurn,
  a: Answering,
  rows: Rows,
  payload: CosTurn
): Promise<Response> {
  if (a.turn.kind === "message") {
    const step = nextStep({
      onboarding: null,
      message: { mode: a.mode, text: a.turn.text },
      newId: a.newId,
    })
    const assistantId = a.newId()
    await run.kit.withOrg({ orgId: run.turn.orgId }, async (db) => {
      await writeAsTurn(db, run.turn, [{ type: "cos.turn", payload }])
      await rows(db, {
        id: assistantId,
        role: "assistant",
        parts: [{ type: "step-start" }, ...step],
      })
    })
    return stream(assistantId, step)
  }
  const history = await run.kit.withOrg({ orgId: run.turn.orgId }, (db) =>
    readSession(db, run.turn.sessionId)
  )
  const { messages } = deriveCosMessages(history, CONTEXT_POLICY)
  const tailId = a.opened.tail?.id as string
  const tail = messages.find((m) => m.id === tailId) as UIMessage
  const message = {
    ...tail,
    parts: [...tail.parts, { type: "step-start" as const }],
  }
  await closeTurn(run, payload, message, rows)
  return stream(tailId, [], settledLead(messages, tailId))
}

/** A message id is written once. A retried send is refused, never merged. */
async function messageTaken(
  db: OrgScopedDb,
  id: string,
  messageId: string
): Promise<boolean> {
  const [taken] = await db
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .where(
      sql`${conversationMessages.conversationId} = ${id} and ${conversationMessages.id} = ${messageId}`
    )
  return taken !== undefined
}

const messageExists = () =>
  failure(409, {
    class: "validation",
    code: "chat.message_exists",
    message: "That message is already in this conversation.",
    detail: {},
  })

/** `parts` with every pending call cancelled, as assistant-ui shows it. */
function cancelParts<P extends { type: string }>(parts: P[]): P[] {
  return parts.map((part) => {
    const p = part as unknown as ToolPart
    if (!isTool(p) || !pending(p)) return part
    const { approval: _, ...rest } = p
    return { ...rest, state: "output-error", errorText: CANCELLED } as never
  })
}

/**
 * What a stored row shows of a message: everything but its reasoning,
 * whether as a part or as a provider's data on one, and a denial's reason
 * in the owner's own words.
 */
const shown = <P extends { type: string }>(parts: P[]): P[] =>
  parts
    .filter((p) => !p.type.startsWith("reasoning"))
    .map((p) => withoutProviderData(p))
    .map((p) => {
      const approval = (p as CosPart).approval
      // Only a denial's reason is framed.
      if (approval?.approved !== false || !approval.reason) return p
      const { reason: _, ...rest } = approval
      const words = ownerWords(approval.reason)
      return {
        ...p,
        approval: words === undefined ? rest : { ...rest, reason: words },
      }
    })

/**
 * The tail with every pending call cancelled, the way assistant-ui's
 * `cancelPendingToolCallsOnSend` cancels it on screen, written back. Null
 * when nothing was pending.
 */
async function cancelPending(
  db: OrgScopedDb,
  id: string,
  tail: Tail | null
): Promise<Content | null> {
  if (
    tail?.content.role !== "assistant" ||
    !tail.content.parts.some((p) => isTool(p) && pending(p))
  ) {
    return null
  }
  // Through `shown`, so a row written before the provider's data was
  // stripped loses it here too.
  const content = {
    ...tail.content,
    parts: shown(cancelParts(tail.content.parts)),
  }
  if (!(await swapTail(db, id, tail, content))) throw new Refusal(stale())
  return content
}

/**
 * A typed message: the owner's row, then a new assistant row with the next
 * step. A call the tail left pending is cancelled first, the way
 * assistant-ui's `cancelPendingToolCallsOnSend` cancels it on screen. While
 * onboarding runs, the message answers the card it cancelled: its fact is
 * stated, or the same card comes back after a line saying what was missing.
 */
async function typed(
  db: OrgScopedDb,
  env: Env,
  kit: Tenancy,
  owner: Owner,
  held: Read,
  id: string,
  message: { mode: "ask" | "act"; text: string },
  messageId: string,
  newId: () => string
): Promise<Response> {
  if (await messageTaken(db, id, messageId)) return messageExists()
  const { tail } = held
  const onboarding = await onboardingOf(db, held, id, owner)
  const card = onboarding ? waitingCard(tail) : undefined
  await cancelPending(db, id, tail)
  const reply = card && typedAnswer(card, message.text)
  const step =
    onboarding && card && reply?.kind === "retry"
      ? again(card, reply.reason, onboarding, newId)
      : onboarding
        ? await advance(db, env, kit, owner, id, onboarding, reply, newId)
        : nextStep({ onboarding, message, newId })
  const assistantId = await ownerThenStep(
    db,
    owner,
    id,
    tail?.id ?? null,
    { id: messageId, text: message.text },
    step,
    newId
  )
  await nameConversation(db, held, id, message.text)
  await db
    .update(conversations)
    .set({ updatedAt: sql`now()` })
    .where(eq(conversations.id, id))
  return stream(assistantId, step)
}

/**
 * The owner's message as a row, then the step in an assistant row of its
 * own after it. The new row's id.
 */
async function ownerThenStep(
  db: OrgScopedDb,
  owner: Owner,
  id: string,
  parentId: string | null,
  message: { id: string; text: string },
  step: Part[],
  newId: () => string
): Promise<string> {
  const assistantId = newId()
  const rows = [
    {
      id: message.id,
      parentId,
      content: { role: "user", parts: [{ type: "text", text: message.text }] },
    },
    {
      id: assistantId,
      parentId: message.id,
      content: { role: "assistant", parts: [{ type: "step-start" }, ...step] },
    },
  ]
  // One statement each, so `seq` keeps the owner's row first.
  for (const row of rows) {
    await db.insert(conversationMessages).values({
      conversationId: id,
      orgId: owner.orgId,
      format: FORMAT,
      ...row,
    })
  }
  return assistantId
}

/** The card the tail's last step waits on, if it waits on one. */
function waitingCard(tail: Tail | null): ToolPart | undefined {
  if (tail?.content.role !== "assistant") return undefined
  const { parts } = tail.content
  const last = parts.slice(parts.map((p) => p.type).lastIndexOf("step-start"))
  return last.find((p): p is ToolPart => isTool(p) && isCard(p) && pending(p))
}

/**
 * Onboarding after an answer, or after none: its fact stated, then the next
 * step. When that step is the build, the change starts here, as the
 * approval path starts it, keyed by the conversation so a retry finishes
 * what the first attempt began. An outcome nobody knows rolls the turn back,
 * so the owner's retry runs it again.
 */
async function advance(
  db: OrgScopedDb,
  env: Env,
  kit: Tenancy,
  owner: Owner,
  id: string,
  onboarding: Onboarding,
  reply: Answer | undefined,
  newId: () => string
): Promise<Part[]> {
  if (reply?.kind === "facts") {
    await stateFacts(db, owner, reply.facts, onboarding.facts as FactRecord[])
  }
  const next = reply ? withAnswer(onboarding, reply) : onboarding
  const step = nextStep({ onboarding: next, message: null, newId })
  const build = buildCall(step)
  if (!build) return step
  const output = await changed(
    env,
    kit,
    owner,
    ONBOARDING_GOAL,
    `onboarding:${id}`
  )
  if (output instanceof Response) throw new Refusal(output)
  return built(next, build, output)
}

/** The tail's call this turn names, or a response saying why not. */
function callIn(
  tail: Tail | null,
  messageId: string,
  match: (part: ToolPart) => boolean
): { tail: Tail; call: ToolPart } | Response {
  if (tail?.id !== messageId || tail.content.role !== "assistant") {
    return stale()
  }
  const { parts } = tail.content
  const call = parts.find((p): p is ToolPart => isTool(p) && match(p))
  if (!call) return stale()
  // A pending call is answered only as the last step's one waiting call;
  // a resolved one falls through to its caller's replay.
  const last = parts.slice(parts.map((p) => p.type).lastIndexOf("step-start"))
  const waiting = last.filter((p) => isTool(p) && pending(p))
  return !pending(call) || (waiting.length === 1 && waiting[0] === call)
    ? { tail, call }
    : stale()
}

/** One result of a results turn, with the message that holds its call. */
type Resolved<K extends ChatResult["kind"]> = Extract<
  ChatResult,
  { kind: K }
> & { message_id: string }

type Reply = Extract<ChatRequest["turn"], { kind: "results" }>["reply"]

/**
 * An answer to one of the script's cards: its fact stated, a skip, or the
 * photos the owner sent, checked against the card the api made. Then the
 * next step: with the owner's reply, the reply and the step each get a row
 * of their own after the card's, and the stream opens the step's row as a
 * new message; without one, the step continues the card's row.
 */
async function answer(
  db: OrgScopedDb,
  env: Env,
  kit: Tenancy,
  owner: Owner,
  held: Read,
  id: string,
  turn: Resolved<"answer">,
  reply: Reply,
  newId: () => string
): Promise<Response> {
  // A reply is written once, as a typed message is: a retry is refused.
  if (reply && (await messageTaken(db, id, reply.message_id))) {
    return messageExists()
  }
  const found = callIn(
    held.tail,
    turn.message_id,
    (p) => isCard(p) && p.toolCallId === turn.tool_call_id
  )
  if (found instanceof Response) return found
  const { tail, call } = found
  const schema = OUTPUTS[call.type as keyof typeof OUTPUTS]
  const output = schema.safeParse(turn.output)
  if (!pending(call)) {
    const given = schema.safeParse(call.output)
    // The same answer again is a retry, and gets the first one's stream.
    return given.success &&
      output.success &&
      JSON.stringify(given.data) === JSON.stringify(output.data)
      ? stream(tail.id, stepAfter(tail.content.parts, call), resolved(call))
      : stale()
  }
  const onboarding = await onboardingOf(db, held, id, owner)
  if (!onboarding) return stale()
  const uploads = factValue(onboarding.facts, "media.uploads")?.items ?? []
  const meant = output.success ? cardAnswer(call, output.data, uploads) : null
  if (!meant || meant.kind === "retry") return answerInvalid()
  const done: ToolPart = {
    ...call,
    state: "output-available",
    output: output.data,
  }
  const step = await advance(db, env, kit, owner, id, onboarding, meant, newId)
  const answered = tail.content.parts.map((p) => (p === call ? done : p))
  if (reply) {
    if (
      !(await swapTail(db, id, tail, {
        ...tail.content,
        parts: shown(answered),
      }))
    ) {
      throw new Refusal(stale())
    }
    const assistantId = await ownerThenStep(
      db,
      owner,
      id,
      tail.id,
      { id: reply.message_id, text: reply.text },
      step,
      newId
    )
    return stream(assistantId, step)
  }
  const parts = [...answered, { type: "step-start" } as const, ...step]
  if (
    !(await swapTail(db, id, tail, { ...tail.content, parts: shown(parts) }))
  ) {
    throw new Refusal(stale())
  }
  return stream(tail.id, step, resolved(done))
}

/**
 * The owner's yes or no on a `request_change`, inside the turn's lock, so a
 * double click or a typed message gets `chat.busy` rather than
 * interleaving. A yes runs the change keyed by the approval id, so a retry
 * after a failed write finishes what the first attempt started.
 */
async function approve(
  db: OrgScopedDb,
  env: Env,
  kit: Tenancy,
  owner: Owner,
  held: Read,
  id: string,
  turn: Resolved<"approval">
): Promise<Response> {
  const matches = (p: ToolPart) =>
    p.type === "tool-request_change" && p.approval?.id === turn.approval_id
  const found = callIn(held.tail, turn.message_id, matches)
  if (found instanceof Response) return found
  const { tail, call } = found
  // Resolved already: the same decision replays it, another is stale.
  const replay = (at: Tail, decided: ToolPart) =>
    decided.approval?.approved === turn.approved
      ? stream(at.id, stepAfter(at.content.parts, decided), resolved(decided))
      : stale()
  if (!pending(call)) return replay(tail, call)
  const approval = { id: turn.approval_id, approved: turn.approved }
  let done: ToolPart = { ...call, state: "output-denied", approval }
  if (turn.approved) {
    const text = (call.input as { text: string }).text
    const output = await changed(env, kit, owner, text, turn.approval_id)
    if (output instanceof Response) return output
    done = { ...call, state: "output-available", approval, output }
  }
  const parts = [
    ...tail.content.parts.map((p) => (p === call ? done : p)),
    { type: "step-start" } as const,
  ]
  if (await swapTail(db, id, tail, { ...tail.content, parts: shown(parts) })) {
    return stream(tail.id, [], resolved(done))
  }
  // Written by something outside the lock meanwhile: this same decision is
  // a replay, anything else is stale.
  const moved = callIn(await readTail(db, id), turn.message_id, matches)
  if (moved instanceof Response) return moved
  return pending(moved.call) ? stale() : replay(moved.tail, moved.call)
}

/**
 * Refusals kept as the card's answer, by class. `validation`
 * (change.question_open, change.build_busy, change.cancelled,
 * staff.developer_missing, the orchestrator's state refusals), `permission`
 * and `budgetary` (builds.daily_cap) say no to this change, and are stored
 * as `refused`. Everything else (`transient` such as an unknown outcome at
 * 503, `provider`, `resource`) is a failed request: answered as it is and
 * not stored, so a retry runs the change again under the same key.
 */
const KEPT: readonly ErrorEnvelope["class"][] = [
  "validation",
  "permission",
  "budgetary",
]

/** The change, started as `/changes` starts it, as the tool's output. */
async function changed(
  env: Env,
  kit: Tenancy,
  owner: Owner,
  text: string,
  key: string
): Promise<RequestChangeOutput | Response> {
  const response = await startChange(env, kit, owner, text, key)
  const body: unknown = await response.clone().json()
  if (response.ok) {
    return { outcome: "started", build: BuildSummary.parse(body) }
  }
  const error = ErrorEnvelope.parse(body)
  if (!KEPT.includes(error.class)) return response
  // The model reads this output, so only the class, the code and the capped
  // message cross; `detail` can hold ids and links and never does.
  return RequestChangeOutput.parse({
    outcome: "refused",
    error: {
      class: error.class,
      code: error.code,
      message: error.message.slice(0, 500),
    },
  })
}

/**
 * An onboarding turn the planner answers, from its first transaction to
 * its model call: the turn's state, and the turn it opened in the session's
 * log, whose `cos.context` holds the reservation and the data the model
 * reads, so a second turn meanwhile is busy and the day's cap counts it.
 */
type PlanJob = {
  turn: Turn
  state: PlanState
  /** The tail as the plan read it: the turn is stale if it moved. */
  tail: Tail | null
}

/** The newest rows of the conversation, oldest first, as the planner reads them. */
async function recentRows(db: OrgScopedDb, id: string): Promise<PlanRow[]> {
  const rows = await db
    .select({ content: conversationMessages.content })
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, id))
    .orderBy(sql`${conversationMessages.seq} desc`)
    .limit(PLANNER.rows)
  return rows.reverse().map((row) => row.content as Content)
}

/**
 * How often each fact has been asked here: the cards in every row, and the
 * questions in words the planner's answered turns sent, read from each such
 * turn's last logged step, the plan the owner saw.
 */
async function askedOf(
  db: OrgScopedDb,
  id: string
): Promise<Record<string, number>> {
  const cards = await db.execute<{ type: string; step: string | null }>(
    sql`select p->>'type' as type,
      coalesce(p->'input'->>'key', p->'input'->>'step') as step
    from ${conversationMessages} m, jsonb_array_elements(m.content->'parts') p
    where m.conversation_id = ${id} and p->>'type' in ('tool-ask_fact', 'tool-ask_choice')`
  )
  const steps = await db.execute<{ text: string | null }>(
    sql`select s.payload->'messages'->0->'content'->0->>'text' as text
    from ${events} s
    join ${events} t on t.session_id = s.session_id and t.type = 'cos.turn'
      and t.payload->>'turn_id' = s.payload->>'turn_id'
      and t.payload->>'outcome' = 'answered'
      and (t.payload->>'steps')::int - 1 = (s.payload->>'step')::int
    join ${events} c on c.session_id = s.session_id and c.type = 'cos.context'
      and c.payload->>'turn_id' = s.payload->>'turn_id'
      and c.payload->>'context_policy_version' = ${PLANNER_VERSION}
    where s.session_id = ${id} and s.type = 'cos.step'`
  )
  const plans = [...steps].flatMap((row) => {
    try {
      const plan = OnboardingPlan.safeParse(JSON.parse(row.text ?? ""))
      return plan.success ? [plan.data] : []
    } catch {
      return []
    }
  })
  return askedSoFar([...cards], plans)
}

/**
 * For the first transaction: the planner's turn, or null when the script
 * answers this one. The script keeps every turn that is not a typed message
 * or one valid answer to the waiting card (a retry, a stale id, an invalid
 * answer, an approval), and every turn over the day's cap. The answer is
 * read exactly as the script reads it; the planner only plans what follows.
 */
async function openPlan(
  db: OrgScopedDb,
  held: Read,
  id: string,
  request: ChatRequest,
  owner: Owner,
  session: Omit<Turn, "turnId">,
  price: NonNullable<ReturnType<typeof priceOf>>
): Promise<PlanJob | null> {
  const onboarding = await onboardingOf(db, held, id, owner)
  if (!onboarding) return null
  const { turn } = request
  let input: PlanInput
  let waitingOn: ToolPart | null = null
  let current = onboarding
  if (turn.kind === "message") {
    if (await messageTaken(db, id, turn.message_id)) return null
    waitingOn = waitingCard(held.tail) ?? null
    input = { kind: "message", text: turn.text }
  } else {
    // A reply already written is the script's to refuse.
    if (turn.reply && (await messageTaken(db, id, turn.reply.message_id))) {
      return null
    }
    const answered = answerOf(held, turn, onboarding)
    if (!answered) return null
    current = withAnswer(onboarding, answered.meant)
    input = { kind: "card", card: answered.call, output: answered.output }
  }
  const state: PlanState = {
    onboarding: current,
    pending: waitingOn,
    input,
    rows: await recentRows(db, id),
    asked: await askedOf(db, id),
  }
  const data = turnData(state)
  const reserved = await planReservation(price, data)
  if (!(await withinCap(db, owner.orgId, reserved))) {
    console.log(
      JSON.stringify({ code: "onboarding.fallback", reason: "budgetary" })
    )
    return null
  }
  const prefix = await plannerPrefix()
  const logged = await sessionState(db, id, prefix.sha256, null)
  const planTurnId: Turn = { ...session, turnId: newUlid() }
  await beginTurn(db, planTurnId, {
    prefix: logged.prefixLogged ? null : prefix,
    messages: [],
    context: {
      turn_id: planTurnId.turnId,
      prefix_sha256: prefix.sha256,
      context_policy_version: PLANNER_VERSION,
      mode: request.mode,
      active_tools: [],
      text: data,
      reserved_usd: reserved,
    },
    contextTaint: ["untrusted_input"],
  })
  return { turn: planTurnId, state, tail: held.tail }
}

/** A results turn's one answer to the waiting card, read as the script reads it, or null. */
function answerOf(
  held: Read,
  turn: Extract<ChatRequest["turn"], { kind: "results" }>,
  onboarding: Onboarding
) {
  const [result, ...more] = turn.results
  if (!result || more.length > 0 || result.kind !== "answer") return null
  const found = callIn(
    held.tail,
    turn.message_id,
    (p) => isCard(p) && p.toolCallId === result.tool_call_id
  )
  if (found instanceof Response || !pending(found.call)) return null
  const output = OUTPUTS[found.call.type as keyof typeof OUTPUTS].safeParse(
    result.output
  )
  if (!output.success) return null
  const uploads = factValue(onboarding.facts, "media.uploads")?.items ?? []
  const meant = cardAnswer(found.call, output.data, uploads)
  if (!meant || meant.kind === "retry") return null
  return { ...found, output: output.data, meant }
}

type Planning = {
  env: Env
  kit: Tenancy
  owner: Owner
  id: string
  request: ChatRequest
  newId: () => string
  model: LanguageModel
  modelId: string
  price: NonNullable<ReturnType<typeof priceOf>>
}

/** A planned turn's rows, before a build it starts is known. */
type Staged = {
  /** The assistant message this turn wrote or continued, and its stored content. */
  id: string
  content: Content
  step: Part[]
  lead: UIMessageChunk[]
  /** The build's pending call, when the plan starts it. */
  build: ToolPart | null
  said: string
  onboarding: Onboarding
}

/**
 * The model's calls as the log keeps a CoS turn's steps: each call's
 * message hash, then its answer with its usage and cost.
 */
async function callEvents(turn: Turn, calls: PlanCall[]) {
  const written = await Promise.all(
    calls.map(async (c, step) => [
      {
        type: "cos.call" as const,
        payload: {
          turn_id: turn.turnId,
          step,
          sha256: await sha256(c.messages),
        },
      },
      {
        type: "cos.step" as const,
        payload: {
          turn_id: turn.turnId,
          step,
          messages: [
            { role: "assistant", content: [{ type: "text", text: c.raw }] },
          ],
          usage: c.usage,
          cost_usd: c.costUsd,
        },
        // The plan quotes the owner's words back.
        taint: ["untrusted_input" as const],
      },
    ])
  )
  return written.flat()
}

/** The planner turn's `cos.turn`: `fallback` when the script answered it. */
function planEnd(
  turn: Turn,
  modelId: string,
  outcome: PlanOutcome,
  ended: "answered" | "fallback" | "error"
): CosTurn {
  const sum = (pick: (c: PlanCall) => number) =>
    outcome.calls.reduce((total, c) => total + pick(c), 0)
  const ran = {
    turn_id: turn.turnId,
    model: modelId,
    usage: {
      input_tokens: sum((c) => c.usage.input_tokens),
      cached_input_tokens: sum((c) => c.usage.cached_input_tokens),
      output_tokens: sum((c) => c.usage.output_tokens),
    },
    cost_usd: sum((c) => c.costUsd),
    tools: [],
    steps: outcome.calls.length,
    // A plan is not streamed, so this is the first call's whole time.
    first_chunk_ms: outcome.calls[0]?.ms ?? null,
  }
  return ended === "fallback"
    ? { ...ran, outcome: "fallback", reason: "provider" }
    : { ...ran, outcome: ended }
}

/**
 * The planner's turn after its first transaction: the model call, outside
 * any transaction, then one transaction that writes the turn as the plan
 * says, or as the script says when there is no plan. A build the plan starts
 * runs after that commit, so the orchestrator's snapshot sees this turn's
 * facts, and its outcome is added to the same message under the same turn,
 * which stays open until then so no other turn can interleave.
 */
async function planned(job: PlanJob, p: Planning): Promise<Response> {
  const outcome = await planTurn(p.model, p.price, job.state)
  console.log(
    JSON.stringify({
      code: "onboarding.plan",
      turn_id: job.turn.turnId,
      ok: outcome.ok,
      reason: outcome.ok ? null : outcome.reason,
      calls: outcome.calls.length,
      ms: outcome.calls.reduce((total, c) => total + c.ms, 0),
      cost_usd: outcome.calls.reduce((total, c) => total + c.costUsd, 0),
    })
  )
  const scope = {
    orgId: p.owner.orgId,
    workosUserId: p.owner.session.workosUserId,
  }
  const steps = await callEvents(job.turn, outcome.calls)
  let logged = false
  const close = (db: OrgScopedDb, ended: "answered" | "fallback" | "error") =>
    writeAsTurn(db, job.turn, [
      ...(logged ? [] : steps),
      {
        type: "cos.turn",
        payload: planEnd(job.turn, p.modelId, outcome, ended),
      },
    ])
  try {
    const staged = await p.kit.withOrg(scope, async (db) => {
      const held = await read(db, p.id)
      if (held instanceof Response) throw new Refusal(held)
      if (JSON.stringify(held.tail) !== JSON.stringify(job.tail)) {
        throw new Refusal(stale())
      }
      const done = outcome.ok
        ? await commitPlan(db, held, job, outcome, p)
        : null
      if (!done) {
        const response = await scriptTurn(
          db,
          p.env,
          p.kit,
          p.owner,
          held,
          p.id,
          p.request,
          p.newId
        )
        await close(db, "fallback")
        return response
      }
      if (done.build) await writeAsTurn(db, job.turn, steps)
      else await close(db, "answered")
      return done
    })
    logged = true
    if (staged instanceof Response) return staged
    if (!staged.build) return stream(staged.id, staged.step, staged.lead)
    return await startPlannedBuild(staged, p, (db) => close(db, "answered"))
  } catch (error) {
    await p.kit
      .withOrg(scope, (db) => close(db, "error"))
      .catch(() => undefined)
    if (error instanceof Refusal) return error.response
    if (error instanceof SessionBusy) return busy()
    if (error instanceof NoSuchSession) return notFound()
    throw error
  }
}

/**
 * The build a plan started: begun as the script begins it, keyed by the
 * conversation, then shown in place of its pending call. A refusal or an
 * outcome nobody knows leaves the owner a line saying it did not start;
 * the next turn can start it again under the same key.
 */
async function startPlannedBuild(
  staged: Staged,
  p: Planning,
  close: (db: OrgScopedDb) => Promise<unknown>
): Promise<Response> {
  const build = staged.build as ToolPart
  const output = await changed(
    p.env,
    p.kit,
    p.owner,
    ONBOARDING_GOAL,
    `onboarding:${p.id}`
  )
  const shownBuild =
    output instanceof Response
      ? [textPart(notStarted(voiceOf(staged.onboarding)))]
      : built(staged.onboarding, build, output, staged.said)
  // By id: the stored parts are copies (`shown`), not the step's objects.
  const swap = (parts: Part[]) =>
    parts.flatMap((part) =>
      isTool(part) && part.toolCallId === build.toolCallId ? shownBuild : [part]
    )
  const content = { ...staged.content, parts: swap(staged.content.parts) }
  const step = swap(staged.step)
  await p.kit.withOrg({ orgId: p.owner.orgId }, async (db) => {
    const row = { id: staged.id, content: staged.content } as unknown as Row
    if (!(await swapTail(db, p.id, row, content))) throw new Refusal(stale())
    await close(db)
  })
  return stream(staged.id, step, staged.lead)
}

/**
 * The plan's turn written, in the same shapes the script writes: a typed
 * message cancels the waiting card and adds the owner's row and a new
 * assistant row; a card answer resolves the card and continues its row. The
 * card's own facts are stated as the script states them, then the plan's,
 * the ones the assistant chose for the owner as `inferred`. The plan is
 * checked again on what this transaction reads, and null (the script
 * answers) when it no longer holds.
 */
async function commitPlan(
  db: OrgScopedDb,
  held: Read,
  job: PlanJob,
  outcome: Extract<PlanOutcome, { ok: true }>,
  p: Planning
): Promise<Staged | null> {
  const onboarding = await onboardingOf(db, held, p.id, p.owner)
  if (!onboarding) throw new Refusal(stale())
  const { turn } = p.request
  const answered =
    turn.kind === "results" ? answerOf(held, turn, onboarding) : null
  if (turn.kind === "results" && !answered) throw new Refusal(stale())
  const state: PlanState = {
    ...job.state,
    onboarding: answered ? withAnswer(onboarding, answered.meant) : onboarding,
  }
  const rechecked = checkPlan(outcome.checked.plan, state)
  if (!rechecked.ok) return null
  const c = rechecked.checked
  const card = answered?.meant.kind === "facts" ? answered.meant.facts : []
  const byKey = new Map(
    [...card, ...c.stated].map((fact) => [fact.key, fact] as const)
  )
  await stateFacts(
    db,
    p.owner,
    [...byKey.values()],
    onboarding.facts as FactRecord[]
  )
  if (c.chosen.length > 0) {
    await stateFacts(db, p.owner, c.chosen, undefined, "inferred")
  }
  const step = planParts(c, state, p.newId)
  const build =
    c.plan.next.kind === "start_build" ? (step[0] as ToolPart) : null
  const base = {
    step,
    build,
    said: c.plan.say.trim(),
    onboarding: c.after,
  }
  if (turn.kind === "message") {
    if (await messageTaken(db, p.id, turn.message_id)) {
      throw new Refusal(messageExists())
    }
    await cancelPending(db, p.id, held.tail)
    const assistantId = await ownerThenStep(
      db,
      p.owner,
      p.id,
      held.tail?.id ?? null,
      { id: turn.message_id, text: turn.text },
      step,
      p.newId
    )
    const content: Content = {
      role: "assistant",
      parts: [{ type: "step-start" }, ...step],
    }
    await db
      .update(conversations)
      .set({ updatedAt: sql`now()` })
      .where(eq(conversations.id, p.id))
    return { ...base, id: assistantId, content, lead: [] }
  }
  const {
    tail,
    call: waitingCall,
    output,
  } = answered as NonNullable<typeof answered>
  const done: ToolPart = { ...waitingCall, state: "output-available", output }
  const answeredParts = tail.content.parts.map((part) =>
    part === waitingCall ? done : part
  )
  // With the owner's reply, as the script does it: the card's row ends with
  // the card, and the reply and the plan's step each get a row of their own.
  const { reply } = turn
  if (reply) {
    if (await messageTaken(db, p.id, reply.message_id)) {
      throw new Refusal(messageExists())
    }
    const finished = { ...tail.content, parts: shown(answeredParts) }
    if (!(await swapTail(db, p.id, tail, finished))) {
      throw new Refusal(stale())
    }
    const assistantId = await ownerThenStep(
      db,
      p.owner,
      p.id,
      tail.id,
      { id: reply.message_id, text: reply.text },
      step,
      p.newId
    )
    const content: Content = {
      role: "assistant",
      parts: [{ type: "step-start" }, ...step],
    }
    return { ...base, id: assistantId, content, lead: [] }
  }
  const content = {
    ...tail.content,
    parts: shown([...answeredParts, { type: "step-start" } as const, ...step]),
  }
  if (!(await swapTail(db, p.id, tail, content))) throw new Refusal(stale())
  return { ...base, id: tail.id, content, lead: resolved(done) }
}

/**
 * The onboarding conversation's first row, for `createOrg` to insert: the
 * opener, then the script's first step for the facts the org holds.
 */
export function firstMessage(
  org: { orgId: string; orgName: string; ownerName: string },
  current: FactRecord[],
  newId: () => string
) {
  const step = openingParts(
    {
      ...org,
      facts: current,
      passed: [],
      closed: [],
      offered: false,
      builder: null,
    },
    newId
  )
  return {
    id: newId(),
    parentId: null,
    format: FORMAT,
    content: {
      role: "assistant" as const,
      parts: [{ type: "step-start" as const }, ...step],
    },
  }
}
