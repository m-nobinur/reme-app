import {
  AskFactInput,
  AskFactOutput,
  BuildSummary,
  ChatRequest,
  ErrorEnvelope,
  type FactRecord,
  FactValue,
  type FactValueKey,
  RequestChangeOutput,
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
export const CANCELLED = "User cancelled tool call by sending a new message."

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
  facts: FactRecord[]
  /** `orgs.name`, the business name's prefill. */
  orgName: string
  /** Keys the owner skipped in this conversation. */
  skipped: readonly FactValueKey[]
  /** Whether this conversation has offered a `request_change` already. */
  offered: boolean
  /** A typed message, or null when a resolved call asks what comes next. */
  message: { mode: "ask" | "act"; text: string } | null
  newId: () => string
}

/** The next step's parts. Pure: the same input and ids give the same parts. */
export function nextStep(s: Script): Part[] {
  if (s.kind === "onboarding" && !s.offered) {
    const key = missingFacts(s.facts).find((k) => !s.skipped.includes(k))
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
    return [changeCall(s.message?.text ?? ONBOARDING_GOAL, s.newId)]
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
type Read = {
  kind: "onboarding" | "assistant"
  rows: Row[]
  tail: (Row & { content: Content }) | null
}

/** The conversation under the session's org, locked for the turn, with its rows. */
async function read(
  db: OrgScopedDb,
  id: string,
  lock: boolean
): Promise<Read | null> {
  const query = db.select().from(conversations).where(eq(conversations.id, id))
  const [conversation] = await (lock ? query.for("update") : query)
  if (!conversation) return null
  const rows = await db
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, id))
    .orderBy(conversationMessages.seq)
  const tail = rows.at(-1) ?? null
  return {
    kind: conversation.kind,
    rows,
    tail: tail as Read["tail"],
  }
}

const partsOf = (rows: Row[]) =>
  rows.flatMap((row) => (row.content as Content).parts)

/** What the script reads from the conversation itself. */
function scriptOf(held: Read) {
  const parts = partsOf(held.rows).filter(isTool)
  return {
    kind: held.kind,
    skipped: parts.flatMap((p) => {
      const output = AskFactOutput.safeParse(p.output)
      return p.type === "tool-ask_fact" &&
        p.state === "output-available" &&
        output.success &&
        output.data.answer === "skipped"
        ? [(p.input as AskFactInput).key]
        : []
    }),
    offered: parts.some((p) => p.type === "tool-request_change"),
  }
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
    if (turn.kind === "approval") {
      return await approve(env, kit, owner, id, turn)
    }
    return await kit.withOrg(scope, async (db) => {
      const held = await read(db, id, true)
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
      return answer(db, owner, held, id, turn, newId)
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
  if (held.rows.some((row) => row.id === messageId)) {
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
  const step = nextStep({
    ...scriptOf(held),
    facts: await readFacts(db),
    orgName: await readOrgName(db),
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

/** The tail's pending call this turn names, or a response saying why not. */
function callIn(
  held: Read,
  messageId: string,
  match: (part: ToolPart) => boolean
): { tail: Row & { content: Content }; call: ToolPart } | Response {
  const { tail } = held
  if (tail?.id !== messageId || tail.content.role !== "assistant")
    return stale()
  const call = tail.content.parts.find(
    (p): p is ToolPart => isTool(p) && match(p)
  )
  return call ? { tail, call } : stale()
}

/** An answer to `ask_fact`: the fact is stated, or the key skipped. */
async function answer(
  db: OrgScopedDb,
  owner: Owner,
  held: Read,
  id: string,
  turn: Extract<ChatRequest["turn"], { kind: "answer" }>,
  newId: () => string
): Promise<Response> {
  const found = callIn(
    held,
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
  if (turn.output.answer === "stated") {
    await stateFacts(db, owner, [turn.output.fact])
  }
  const done: ToolPart = {
    ...call,
    state: "output-available",
    output: turn.output,
  }
  const before = scriptOf(held)
  const step = nextStep({
    ...before,
    skipped:
      turn.output.answer === "skipped"
        ? [...before.skipped, key]
        : before.skipped,
    facts: await readFacts(db),
    orgName: await readOrgName(db),
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
 * The owner's yes or no on a `request_change`. A yes runs the change before
 * the write, keyed by the approval id, so a retry after a failed write
 * replays the build the first attempt made rather than starting another.
 */
async function approve(
  env: Env,
  kit: Tenancy,
  owner: Owner,
  id: string,
  turn: Extract<ChatRequest["turn"], { kind: "approval" }>
): Promise<Response> {
  const held = await kit.withOrg({ orgId: owner.orgId }, (db) =>
    read(db, id, false)
  )
  if (!held) return notFound()
  const found = callIn(
    held,
    turn.message_id,
    (p) =>
      p.type === "tool-request_change" && p.approval?.id === turn.approval_id
  )
  if (found instanceof Response) return found
  const { tail, call } = found
  if (!pending(call)) {
    return call.approval?.approved === turn.approved
      ? stream(tail.id, stepAfter(tail.content.parts, call), call)
      : stale()
  }
  const approval = { id: turn.approval_id, approved: turn.approved }
  const done: ToolPart = turn.approved
    ? {
        ...call,
        state: "output-available",
        approval,
        output: await changed(
          env,
          kit,
          owner,
          (call.input as { text: string }).text,
          turn.approval_id
        ),
      }
    : { ...call, state: "output-denied", approval }
  const parts = [
    ...tail.content.parts.map((p) => (p === call ? done : p)),
    { type: "step-start" } as const,
  ]
  const swapped = await kit.withOrg({ orgId: owner.orgId }, (db) =>
    swapTail(db, id, tail, { ...tail.content, parts })
  )
  return swapped ? stream(tail.id, [], done) : stale()
}

/** The change, started as `/changes` would start it, as the tool's output. */
async function changed(
  env: Env,
  kit: Tenancy,
  owner: Owner,
  text: string,
  key: string
): Promise<RequestChangeOutput> {
  const response = await startChange(env, kit, owner, text, key)
  const body: unknown = await response.json()
  if (response.ok) {
    return { outcome: "started", build: BuildSummary.parse(body) }
  }
  const { occurred_at: _, ...error } = ErrorEnvelope.parse(body)
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
    facts: [],
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
