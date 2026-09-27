import {
  AskFactInput,
  AskFactOutput,
  BuildSummary,
  ChatRequest,
  type ChatResult,
  type CosTurn,
  ErrorEnvelope,
  FactValue,
  type FactValueKey,
  RequestChangeOutput,
  TOOL_CALL_CANCELLED,
} from "@workspace/contracts"
import {
  conversationMessages,
  conversations,
  eq,
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
  LIMITS,
  messageTaint,
  newRunState,
  openrouterModel,
  priceOf,
  reservation,
} from "./cos/agent.ts"
import {
  CONTEXT_POLICY,
  deriveCosMessages,
  readSession,
} from "./cos/history.ts"
import {
  closeTurn,
  type FellBack,
  type Rows,
  ranTurn,
  settle,
  streamTurn,
  withoutProviderData,
} from "./cos/run.ts"
import { getWorkspace, type ToolFailed } from "./cos/tools.ts"
import {
  beginTurn,
  chiefStaffId,
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
import { failure, invalid, readBody, sortedKeys } from "./http.ts"
import { ownerStaffId } from "./staff.ts"
import { missingFacts, readFacts } from "./workspace.ts"

/**
 * `POST /chat`: a turn, answered by the Chief of Staff (ADR-034) or by the
 * script. The script owns the onboarding conversation until its build offer
 * is approved or refused, and every results turn on a call it made: it asks
 * for each missing fact with `ask_fact`, then offers the first build with a
 * `request_change` the owner approves. Every other turn goes to the CoS,
 * whose history is the event log; when the CoS has no model, no budget, a
 * frozen conversation or a provider that fails before any content, the
 * script's step stands in for it: a change card in Act mode and one fixed
 * line in Ask.
 *
 * The client sends only what the owner just did (`ChatRequest`). The stored
 * rows are what assistant-ui reads, written in the same transactions as the
 * log, so a reload shows what the stream showed. A continued message is one
 * row that grows: ai 7 continues the last assistant message, so an answer or
 * an approval updates that row and never appends a second one.
 */

/** The facts an owner may skip. Pricing only: the rest the site needs. */
export const SKIPPABLE: readonly FactValueKey[] = [
  "pricing.standard_clean_hourly",
]

/** The first build's goal, when the owner has not typed one. */
export const ONBOARDING_GOAL = "Build my website from the details I gave you."

/** Ask mode's one line when the Chief of Staff cannot answer: the script's, or the fallback's. */
export const ASK_REPLY =
  "I can't answer right now. Try again in a moment, or switch to Act and tell me what to change on your site."

/** assistant-ui's words when a new message cancels a pending call, so a reload matches. */
export const CANCELLED = TOOL_CALL_CANCELLED

/** `format` on every row: `aiSDKV6FormatAdapter.format`, v6 even on ai 7. */
const FORMAT = "ai-sdk/v6"

export type ToolPart = {
  type: "tool-ask_fact" | "tool-request_change"
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
  kind: "onboarding" | "assistant"
  /** The required facts the org does not hold, in asking order (`missingFacts`). */
  missing: readonly FactValueKey[]
  /** `orgs.name`, the business name's prefill. Read only when that is the ask. */
  orgName: string
  /** Keys the owner skipped in this conversation. */
  skipped: readonly FactValueKey[]
  /** Whether the owner approved or refused an offer in this conversation. */
  offered: boolean
  /** A typed message, or null when a resolved call asks what comes next. */
  message: { mode: "ask" | "act"; text: string } | null
  newId: () => string
}

/** The key onboarding asks for next, if any. */
export const nextKey = (s: Pick<Script, "missing" | "skipped">) =>
  s.missing.find((k) => !s.skipped.includes(k))

/**
 * The next step's parts. Pure: the same input and ids give the same parts.
 * An Ask message never becomes a change, onboarding included.
 */
export function nextStep(s: Script): Part[] {
  if (s.kind === "onboarding" && !s.offered) {
    const key = nextKey(s)
    if (key) {
      const name = FactValue.safeParse({
        key: "business.name",
        value: { name: s.orgName },
      })
      const input = AskFactInput.parse({
        key,
        skippable: SKIPPABLE.includes(key),
        prefill:
          key === "business.name" && name.success ? name.data.value : null,
      })
      return [
        {
          type: "tool-ask_fact",
          toolCallId: s.newId(),
          state: "input-available",
          input,
        },
      ]
    }
    if (s.message?.mode !== "ask") {
      return [changeCall(s.message?.text ?? ONBOARDING_GOAL, s.newId)]
    }
  }
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
  return call
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
 * What the script reads from an onboarding conversation: the keys the owner
 * skipped, and whether they approved or refused an offer. An offer talked
 * over by a typed message was cancelled, not made, so it does not count.
 */
export async function readScript(
  db: OrgScopedDb,
  id: string
): Promise<{ skipped: FactValueKey[]; offered: boolean }> {
  const [found] = await db.execute<{
    skipped: FactValueKey[]
    offered: boolean
  }>(
    sql`select
      coalesce(jsonb_agg(distinct p->'input'->>'key') filter (where p->>'type' = 'tool-ask_fact' and p->>'state' = 'output-available' and p->'output'->>'answer' = 'skipped'), '[]'::jsonb) as skipped,
      coalesce(bool_or(p->>'type' = 'tool-request_change' and p->>'state' in ('output-available', 'output-denied')), false) as offered
    from ${conversationMessages} m, jsonb_array_elements(m.content->'parts') p
    where m.conversation_id = ${id} and m.content->>'role' = 'assistant'`
  )
  return { skipped: found?.skipped ?? [], offered: found?.offered ?? false }
}

/**
 * The next step for this conversation, reading only what it needs: the
 * script's state for onboarding, and the org's name only when the step asks
 * for the business name.
 */
async function next(
  db: OrgScopedDb,
  held: Read,
  id: string,
  input: Pick<Script, "missing" | "message" | "newId">
): Promise<Part[]> {
  const { skipped, offered } =
    held.kind === "onboarding"
      ? await readScript(db, id)
      : { skipped: [], offered: true }
  const asking =
    !offered && nextKey({ missing: input.missing, skipped }) === "business.name"
  return nextStep({
    ...input,
    kind: held.kind,
    skipped,
    offered,
    orgName: asking ? await readOrgName(db) : "",
  })
}

async function readOrgName(db: OrgScopedDb): Promise<string> {
  const [org] = await db.select({ name: orgs.name }).from(orgs).limit(1)
  return org?.name ?? ""
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
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conversationId))
  return true
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
  const { conversation_id: id, mode, turn } = parsed.data
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
  let opened: Opened | Response
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
        (held.kind === "onboarding" && !(await readScript(db, id)).offered) ||
        (turn.kind === "results" && !log.named)
      if (scripted)
        return scriptTurn(db, env, kit, owner, held, id, parsed.data, newId)
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
      const context = contextOf(mode, workspace)
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
  const run: AgentTurn = {
    turn: opened.turn,
    kit,
    tools,
    price: price ?? { input: 0, output: 0, cacheRead: 0 },
    reserved: opened.reserved,
    state: newRunState(),
    abort: new AbortController(),
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
    return answer(db, owner, held, id, one, newId)
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

/** The chunks that show a CoS call as the owner's results left it. */
function settledChunks(part: CosPart): UIMessageChunk[] {
  const toolCallId = part.toolCallId as string
  const response: UIMessageChunk[] = part.approval
    ? [
        {
          type: "tool-approval-response",
          approvalId: part.approval.id,
          approved: part.approval.approved === true,
          ...(part.approval.reason === undefined
            ? {}
            : { reason: part.approval.reason }),
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
    const approval = {
      id: result.approval_id,
      approved: result.approved,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
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
    .set({ updatedAt: new Date() })
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
      kind: "assistant",
      missing: [],
      orgName: "",
      skipped: [],
      offered: true,
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
 * whether as a part or as a provider's data on one.
 */
const shown = <P extends { type: string }>(parts: P[]): P[] =>
  parts
    .filter((p) => !p.type.startsWith("reasoning"))
    .map((p) => withoutProviderData(p))

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
  const content = { ...tail.content, parts: cancelParts(tail.content.parts) }
  if (!(await swapTail(db, id, tail, content))) throw new Refusal(stale())
  return content
}

/**
 * A typed message: the owner's row, then a new assistant row with the next
 * step. A call the tail left pending is cancelled first, the way
 * assistant-ui's `cancelPendingToolCallsOnSend` cancels it on screen.
 */
async function typed(
  db: OrgScopedDb,
  owner: Owner,
  held: Read,
  id: string,
  message: { mode: "ask" | "act"; text: string },
  messageId: string,
  newId: () => string
): Promise<Response> {
  if (await messageTaken(db, id, messageId)) return messageExists()
  const { tail } = held
  await cancelPending(db, id, tail)
  const step = await next(db, held, id, {
    missing: missingFacts(await readFacts(db)),
    message,
    newId,
  })
  const assistantId = newId()
  const rows = [
    {
      id: messageId,
      parentId: tail?.id ?? null,
      content: { role: "user", parts: [{ type: "text", text: message.text }] },
    },
    {
      id: assistantId,
      parentId: messageId,
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
  await db
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, id))
  return stream(assistantId, step)
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

/** An answer to `ask_fact`: the fact is stated, or the key skipped. */
async function answer(
  db: OrgScopedDb,
  owner: Owner,
  held: Read,
  id: string,
  turn: Resolved<"answer">,
  newId: () => string
): Promise<Response> {
  const found = callIn(
    held.tail,
    turn.message_id,
    (p) => p.type === "tool-ask_fact" && p.toolCallId === turn.tool_call_id
  )
  if (found instanceof Response) return found
  const { tail, call } = found
  const output = JSON.stringify(turn.output)
  if (!pending(call)) {
    const given = AskFactOutput.safeParse(call.output)
    // The same answer again is a retry, and gets the first one's stream.
    return given.success && JSON.stringify(given.data) === output
      ? stream(tail.id, stepAfter(tail.content.parts, call), resolved(call))
      : stale()
  }
  const { key } = call.input as AskFactInput
  if (
    turn.output.answer === "stated"
      ? turn.output.fact.key !== key
      : !SKIPPABLE.includes(key)
  ) {
    return answerInvalid()
  }
  const current = await readFacts(db)
  if (turn.output.answer === "stated") {
    await stateFacts(db, owner, [turn.output.fact], current)
  }
  const done: ToolPart = {
    ...call,
    state: "output-available",
    output: turn.output,
  }
  const step = await next(db, held, id, {
    // The key just answered is held now, or skipped.
    missing: missingFacts(current).filter((k) => k !== key),
    message: null,
    newId,
  })
  const parts = [
    ...tail.content.parts.map((p) => (p === call ? done : p)),
    { type: "step-start" } as const,
    ...step,
  ]
  if (!(await swapTail(db, id, tail, { ...tail.content, parts }))) {
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
  if (await swapTail(db, id, tail, { ...tail.content, parts })) {
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
 * The onboarding conversation's first row, for `createOrg` to insert: the
 * script's first step for an org with no facts, asking for the business name
 * with `orgs.name` filled in.
 */
export function firstMessage(orgName: string, newId: () => string) {
  const step = nextStep({
    kind: "onboarding",
    missing: missingFacts([]),
    orgName,
    skipped: [],
    offered: false,
    message: null,
    newId,
  })
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
