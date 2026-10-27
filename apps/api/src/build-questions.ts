import {
  ADDRESS_ASK,
  BuildQuestions,
  ErrorEnvelope,
  FactValue,
  FactValueKey,
  GOAL_MAX,
  InformationAnswer,
  idempotencyKey,
  OwnerAnswerText,
  PRIVATE_FACT_KEYS,
  type QuestionAnswer,
  type QuestionInput,
  QuestionReply,
  Uuid,
} from "@workspace/contracts"
import {
  conversationMessages,
  currentFact,
  failureCode,
  type OrgScopedDb,
  openTask,
  putOff,
  type SQL,
  setStep,
  sql,
  supersedeFact,
  type Tenancy,
} from "@workspace/db"
import { bridge, type Owner, relay, startChange } from "./changes.ts"
import { holdsNul, notFound } from "./conversations.ts"
import { failure, invalid, keyMissing, readBody } from "./http.ts"
import { ownerStaffId } from "./staff.ts"

/**
 * The questions the assistant puts to the owner on a card in the chat
 * (`BuildQuestionsPart`), answered one at a time. An answer needs no yes: a
 * build's question goes to the build at once, and a ready draft's offer is
 * stored as the owner's fact, with one change started once the stack is
 * settled. The settled answer is written back into the stored part, so the
 * card folds and a reload shows it answered.
 */

const PART = "data-build_questions"

type Content = { role: string; parts: { type: string; data?: unknown }[] }
type Held = {
  conversationId: string
  messageId: string
  content: Content
  at: number
  stack: BuildQuestions
}

/** The stack one stored message holds, and where; under the row's lock when `lock`. */
async function readStack(
  db: OrgScopedDb,
  where: SQL,
  lock = false
): Promise<Held | null> {
  const [row] = await db.execute<{
    conversation_id: string
    id: string
    content: Content
  }>(sql`
    select conversation_id, id, content from ${conversationMessages}
    where ${where} limit 1 ${lock ? sql`for update` : sql``}`)
  const at = row?.content.parts.findIndex((p) => p.type === PART) ?? -1
  const stack = BuildQuestions.safeParse(row?.content.parts[at]?.data)
  if (!row || !stack.success) return null
  return {
    conversationId: row.conversation_id,
    messageId: row.id,
    content: row.content,
    at,
    stack: stack.data,
  }
}

/** The message whose stack asks this question, wherever it is. */
const asking = (questionId: string) =>
  sql`content->'parts' @> ${JSON.stringify([
    { type: PART, data: { questions: [{ id: questionId }] } },
  ])}::jsonb`

/** One question settled in its stack, unless it already was; the stack as stored. */
async function settle(
  db: OrgScopedDb,
  held: Held,
  questionId: string,
  answer: QuestionAnswer
): Promise<BuildQuestions> {
  const stack = {
    ...held.stack,
    questions: held.stack.questions.map((q) =>
      q.id === questionId && !q.answer ? { ...q, answer } : q
    ),
  }
  const parts = held.content.parts.map((p, i) =>
    i === held.at ? { ...p, data: stack } : p
  )
  await db.execute(sql`
    update ${conversationMessages}
    set content = ${JSON.stringify({ ...held.content, parts })}::jsonb
    where conversation_id = ${held.conversationId} and id = ${held.messageId}`)
  return stack
}

/**
 * The card for this question, settled with what the owner said in the chat
 * instead, when the assistant passed it on (`answer_question`). Nothing
 * when no card asks it.
 */
export async function settleCard(
  db: OrgScopedDb,
  questionId: string,
  answer: QuestionAnswer
): Promise<void> {
  const held = await readStack(db, asking(questionId), true)
  if (held) await settle(db, held, questionId, answer)
}

const isEmail = (address: string) =>
  FactValue.safeParse({ key: "business.email", value: { address } }).success

/** Whether `value` is an answer the card's input could give. */
export function fits(input: QuestionInput, value: unknown): boolean {
  if (input.kind === "fact") {
    return FactValue.safeParse({ key: input.key, value }).success
  }
  if (typeof value !== "string") return false
  if (input.kind === "choice") return input.options.includes(value)
  return (
    OwnerAnswerText.max(input.maxLength).safeParse(value).success &&
    (!input.email || isEmail(value))
  )
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** The answer, in the owner's words, for the change it starts. */
const said = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Object.values(value as Record<string, unknown>)
        .flat()
        .join(", ")

/**
 * The change a settled offer starts, once, keyed by its message: the
 * questions the owner answered and their answers, which are already their
 * facts. Nothing when every one was skipped. Never fails the answer: the
 * facts are stored either way.
 */
async function startOffer(
  env: Env,
  kit: Tenancy,
  owner: Owner,
  messageId: string,
  stack: BuildQuestions
): Promise<void> {
  if (stack.kind !== "offer" || stack.questions.some((q) => !q.answer)) return
  const given = stack.questions.flatMap((q) =>
    q.answer?.kind === "value" ? [`${q.text} ${said(q.answer.value)}`] : []
  )
  if (given.length === 0) return
  const text = `Add these details to the site: ${given.join(" ")}`.slice(
    0,
    GOAL_MAX
  )
  try {
    const started = await startChange(
      env,
      kit,
      owner,
      text,
      `offer:${messageId}`,
      "section"
    )
    if (!started.ok) {
      const code = ErrorEnvelope.safeParse(await started.json()).data?.code
      console.error(
        JSON.stringify({ code: "offer.change_refused", refused: code })
      )
    }
  } catch (error) {
    console.error(
      JSON.stringify({ code: "offer.change_failed", error: failureCode(error) })
    )
  }
}

/**
 * Whether an offer may store its answer as `field`: a business fact, and a
 * `FactValue` key only through that key's own inputs, so a text answer never
 * lands on a key with a fixed shape.
 */
export function storable(field: string, input: QuestionInput): boolean {
  if (PRIVATE_FACT_KEYS.includes(field)) return false
  return FactValueKey.safeParse(field).success
    ? input.kind === "fact" && input.key === field
    : input.kind !== "fact"
}

/** The owner's answer to an offer, stored as their fact. */
async function stateOffer(
  db: OrgScopedDb,
  owner: Owner,
  field: string,
  value: unknown
) {
  const root = await ownerStaffId(db, {
    orgId: owner.orgId,
    workosUserId: owner.session.workosUserId,
    ownerName: owner.session.name ?? owner.session.email,
  })
  const was = await currentFact(db, field)
  await supersedeFact(db, {
    orgId: owner.orgId,
    key: field,
    factType: was?.factType ?? field.split(".")[0] ?? "fact",
    value,
    provenance: {
      source: "owner_stated",
      confidence: 1,
      verifiedByStaffId: root,
    },
  })
}

/** How long a Not now holds the address question back. */
const ADDRESS_LATER_DAYS = 7

/**
 * The owner's answer to "Do you already have a web address?" on the address
 * task. A Yes changes nothing here: the card's reply carries the name into a
 * normal turn, which connects it. A No means finding out is over and a name
 * is next; Not now puts the task off. Both close the page that asks for the
 * name, which the owner will not see. The stack as stored.
 */
async function answerAddress(
  db: OrgScopedDb,
  orgId: string,
  held: Held,
  question: BuildQuestions["questions"][number],
  value: unknown
): Promise<BuildQuestions> {
  const [ask, name] = held.stack.questions
  if (question.id !== ask?.id || value === ADDRESS_ASK.yes) return held.stack
  const task = await openTask(db, orgId, "address")
  if (value === ADDRESS_ASK.no) {
    await setStep(db, task, "find_out", { state: "done" })
    await setStep(db, task, "choose", {
      state: "blocked",
      blocked_on: "owner_action",
      note: "Picking a name",
    })
  } else {
    await putOff(db, task, ADDRESS_LATER_DAYS)
  }
  return name ? settle(db, held, name.id, { kind: "closed" }) : held.stack
}

const questionNotFound = () =>
  failure(404, {
    class: "resource",
    code: "question.not_found",
    message: "No question with that id in this conversation.",
    detail: {},
  })

/**
 * `POST /conversations/{id}/questions` (`QuestionReply`). The same answer
 * again is a retry and gets the stack back; another answer to a settled
 * question is 409 `question.answered`. A build that no longer waits on the
 * question closes it, so the card folds instead of failing.
 */
export async function answerQuestions(
  request: Request,
  env: Env,
  kit: Tenancy,
  owner: Owner,
  id: string
): Promise<Response> {
  const key = idempotencyKey(request)
  if (!key) return keyMissing()
  const parsed = QuestionReply.safeParse(await readBody(request))
  if (!parsed.success) return invalid(parsed.error.issues)
  if (holdsNul(parsed.data)) return invalid([{ path: ["answer"] }])
  if (!Uuid.safeParse(id).success) return notFound()
  const { message_id: messageId, question_id: questionId, answer } = parsed.data
  const scope = { orgId: owner.orgId, workosUserId: owner.session.workosUserId }
  const where = sql`conversation_id = ${id}::uuid and id = ${messageId}`
  const held = await kit.withOrg(scope, (db) => readStack(db, where))
  const asked = held?.stack.questions.find((q) => q.id === questionId)
  if (!held || !asked) return questionNotFound()
  if (asked.answer) {
    if (!same(asked.answer, answer)) {
      return failure(409, {
        class: "validation",
        code: "question.answered",
        message: "That question has been answered.",
        detail: {},
      })
    }
    await startOffer(env, kit, owner, messageId, held.stack)
    return Response.json(held.stack)
  }
  const ok =
    answer.kind === "skipped"
      ? asked.skippable
      : fits(asked.input, answer.value) &&
        (!asked.field || storable(asked.field, asked.input))
  if (!ok) {
    return failure(400, {
      class: "validation",
      code: "answer.invalid",
      message: "That answer is not one this question takes.",
      detail: {},
    })
  }
  let settled: QuestionAnswer = answer
  if (held.stack.kind === "build" && answer.kind === "value") {
    const sent = await bridge(
      env,
      owner,
      `/${held.stack.assignment_id}/answer`,
      {
        body: { request_id: asked.id, value: answer.value },
        key,
      }
    )
    const code = ErrorEnvelope.safeParse(sent.body).data?.code
    // The build no longer waits on it, or took another answer first.
    const gone =
      code === "assignment.not_waiting" ||
      code === "request.not_found" ||
      code === "answer.already_given"
    if (sent.status >= 300 && !gone) return relay(sent, InformationAnswer.parse)
    if (gone) settled = { kind: "closed" }
  }
  const stack = await kit.withOrg(scope, async (db) => {
    const locked = await readStack(db, where, true)
    if (!locked) return null
    const offered = locked.stack.questions.find((q) => q.id === questionId)
    if (offered?.field && !offered.answer && answer.kind === "value") {
      await stateOffer(db, owner, offered.field, answer.value)
    }
    const stored = await settle(db, locked, questionId, settled)
    return locked.stack.kind === "address" && offered && answer.kind === "value"
      ? answerAddress(
          db,
          owner.orgId,
          { ...locked, stack: stored },
          offered,
          answer.value
        )
      : stored
  })
  if (!stack) return questionNotFound()
  await startOffer(env, kit, owner, messageId, stack)
  return Response.json(stack)
}
