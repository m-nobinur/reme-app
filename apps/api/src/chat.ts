import {
  AskFactInput,
  AskFactOutput,
  BuildSummary,
  ChatRequest,
  type ChatResult,
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
  type OrgScopedDb,
  orgs,
  sql,
  type Tenancy,
} from "@workspace/db"
// Types only: the frames are written here by hand, so `ai` never enters the
// bundle (about 49 KiB gzip for `createUIMessageStream`).
import type { UIMessageChunk } from "ai"
import { holdsNul, notFound } from "./conversations.ts"
import { failure, invalid, readBody } from "./http.ts"
import { type Owner, startChange, stateFacts } from "./owner.ts"
import { missingFacts, readFacts } from "./workspace.ts"

/**
 * `POST /chat`, with no model: a script. In the onboarding conversation it
 * asks for each missing fact with `ask_fact`, then offers the first build
 * with a `request_change` the owner approves. After that, and in every
 * assistant conversation, a typed message in Act mode becomes a
 * `request_change`, and in Ask mode gets one fixed line.
 *
 * The client sends only what the owner just did (`ChatRequest`); history is
 * the stored rows. Each turn is written first and then streamed, so a
 * reload shows what the stream showed. The onboarding transcript is one
 * assistant row that grows: ai 7 continues the last assistant message, so
 * an answer or an approval updates that row, compare-and-swap on its
 * content, and never appends a second one.
 */

/** The facts an owner may skip. Pricing only: the rest the site needs. */
export const SKIPPABLE: readonly FactValueKey[] = [
  "pricing.standard_clean_hourly",
]

/** The first build's goal, when the owner has not typed one. */
export const ONBOARDING_GOAL = "Build my website from the details I gave you."

/** The whole of Ask mode until the Chief of Staff can answer. */
export const ASK_REPLY =
  "I can't answer questions yet. Switch to Act and tell me what to change on your site."

/** assistant-ui's words when a new message cancels a pending call, so a reload matches. */
export const CANCELLED = TOOL_CALL_CANCELLED

/** `format` on every row: `aiSDKV6FormatAdapter.format`, v6 even on ai 7. */
const FORMAT = "ai-sdk/v6"

/** ai 7.0.83's `UI_MESSAGE_STREAM_HEADERS`, copied because only its types are imported. */
export const STREAM_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "x-vercel-ai-ui-message-stream": "v1",
  "x-accel-buffering": "no",
}

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
  call: ToolPart | null = null
): Response {
  const chunks: UIMessageChunk[] = [
    { type: "start", messageId },
    { type: "start-step" },
    ...(call ? resolved(call) : []),
    ...step.flatMap(made),
    { type: "finish-step" },
    { type: "finish" },
  ]
  const frames = chunks.map(
    (chunk) => `data: ${JSON.stringify(chunk, sortedKeys)}\n\n`
  )
  return new Response(`${frames.join("")}data: [DONE]\n\n`, {
    headers: STREAM_HEADERS,
  })
}

/**
 * Keys in code-point order at every depth. A replay reads the call back from
 * jsonb, which keeps its own key order, so without this a retry would send
 * the same chunks in different bytes.
 */
const sortedKeys = (_key: string, value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      )
    : value

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
 * The conversation under the session's org and its last row, the
 * conversation locked for the rest of the turn so turns on it run one at a
 * time. Null for one the org does not hold.
 */
async function read(db: OrgScopedDb, id: string): Promise<Read | null> {
  const [conversation] = await db
    .select({ kind: conversations.kind })
    .from(conversations)
    .where(eq(conversations.id, id))
    .for("update")
  if (!conversation) return null
  return { kind: conversation.kind, tail: await readTail(db, id) }
}

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

export async function chat(
  request: Request,
  env: Env,
  kit: Tenancy,
  owner: Owner,
  newId: () => string = () => crypto.randomUUID()
): Promise<Response> {
  const body = await readBody(request)
  const parsed = ChatRequest.safeParse(body)
  if (!parsed.success) return invalid(parsed.error.issues)
  // Postgres refuses NUL in text and jsonb, and a refusal there is a 500.
  if (holdsNul(parsed.data)) return invalid([{ path: ["turn"] }])
  const { conversation_id: id, mode, turn } = parsed.data
  const scope = { orgId: owner.orgId, workosUserId: owner.session.workosUserId }
  try {
    return await kit.withOrg(scope, async (db) => {
      const held = await read(db, id)
      if (!held) return notFound()
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
      if (!result || more.length > 0) return stale()
      const one = { message_id: turn.message_id, ...result }
      if (one.kind === "answer") {
        return answer(db, owner, held, id, one, newId)
      }
      return approve(db, env, kit, owner, held, id, one)
    })
  } catch (error) {
    if (error instanceof Refusal) return error.response
    throw error
  }
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
  // A message id is written once. A retried send is refused, never merged.
  const [taken] = await db
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .where(
      sql`${conversationMessages.conversationId} = ${id} and ${conversationMessages.id} = ${messageId}`
    )
  if (taken) {
    return failure(409, {
      class: "validation",
      code: "chat.message_exists",
      message: "That message is already in this conversation.",
      detail: {},
    })
  }
  const { tail } = held
  if (
    tail?.content.role === "assistant" &&
    tail.content.parts.some((p) => isTool(p) && pending(p))
  ) {
    const parts = tail.content.parts.map((part): Part => {
      if (!isTool(part) || !pending(part)) return part
      const { approval: _, ...rest } = part
      return { ...rest, state: "output-error", errorText: CANCELLED }
    })
    if (!(await swapTail(db, id, tail, { ...tail.content, parts }))) {
      throw new Refusal(stale())
    }
  }
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
      ? stream(tail.id, stepAfter(tail.content.parts, call), call)
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
  return stream(tail.id, step, done)
}

/**
 * The owner's yes or no on a `request_change`, inside the turn's lock, so a
 * double click or a typed message waits for it rather than interleaving. A
 * yes runs the change keyed by the approval id, so a retry after a failed
 * write replays the build the first attempt made.
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
      ? stream(at.id, stepAfter(at.content.parts, decided), decided)
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
    return stream(tail.id, [], done)
  }
  // Written by something outside the lock meanwhile: this same decision is
  // a replay, anything else is stale.
  const moved = callIn(await readTail(db, id), turn.message_id, matches)
  if (moved instanceof Response) return moved
  return pending(moved.call) ? stale() : replay(moved.tail, moved.call)
}

/**
 * Refusals kept as the card's answer, by class. `validation`
 * (change.question_open, change.build_busy, staff.developer_missing, the
 * orchestrator's state refusals), `permission` and `budgetary`
 * (builds.daily_cap) say no to this change, and are stored as `refused`.
 * Everything else (`integrity` such as orchestrator.off_contract at 502,
 * `transient` such as request.failed at 503, `provider`, `resource`) is a
 * failed request: answered as it is and not stored, so a retry runs the
 * change again under the same key.
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
  const { occurred_at: _, ...error } = ErrorEnvelope.parse(body)
  if (!KEPT.includes(error.class)) return response
  return RequestChangeOutput.parse({ outcome: "refused", error })
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
