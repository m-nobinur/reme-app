import {
  type AnswerQuestionInput,
  type AnswerQuestionOutput,
  BuildSummary,
  CosFacts,
  CosWorkspace,
  ErrorEnvelope,
  type FactRecord,
  FactValue,
  type GetPreviewInput,
  GetPreviewOutput,
  InformationAnswer,
  type OwnerChangeRequest,
  PreviewLink,
  RequestChangeOutput,
} from "@workspace/contracts"
import {
  assignments,
  eq,
  events,
  siteRevisions,
  sql,
  type Tenancy,
  waitedOn,
} from "@workspace/db"
import { failure } from "../http.ts"
import {
  bridge,
  holds,
  notFound,
  type Owner,
  relay,
  startChange,
} from "../owner.ts"
import { readFacts, readWorkspace } from "../workspace.ts"

/**
 * The Chief of Staff's five tools (ADR-034), as plain functions: the
 * session's org, user and session in, the contract's output out. What they
 * return is what the model reads, so each is cut to its `COS_TOOLS` output:
 * no org or staff id, no URL, no open record, and every refusal the closed
 * `{class, code, message}`. Each opens its own `withOrg`, outside any
 * conversation lock. The act tools take the approval id as their key, so
 * running one twice replays the first run.
 */

export type ToolContext = { env: Env; kit: Tenancy; owner: Owner }

type Empty = Record<string, never>
type Refused = Extract<GetPreviewOutput, { outcome: "refused" }>

/** Another agent's text, and any message, is capped where the model reads it. */
const TEXT_MAX = 500

/** An api refusal as the model reads it: its class, code and message, nothing else. */
async function refused(response: Response): Promise<Refused> {
  const error = ErrorEnvelope.parse(await response.json())
  return {
    outcome: "refused",
    error: {
      class: error.class,
      code: error.code,
      message: error.message.slice(0, TEXT_MAX),
    },
  }
}

export async function getWorkspace(
  { env, kit, owner }: ToolContext,
  _input: Empty
): Promise<CosWorkspace> {
  const status = await readWorkspace(kit, owner.orgId, env.SITE_HOST_SUFFIX)
  return CosWorkspace.parse({
    site: {
      host: status.site.host,
      live_version: status.site.live?.version ?? null,
    },
    builds: status.builds.map((b) => ({
      assignment_id: b.assignment_id,
      kind: b.kind,
      state: b.state,
      goal: b.goal,
      version: b.revision?.version ?? null,
    })),
    questions: status.attention
      .flatMap((item) => (item.kind === "question" ? [item.request] : []))
      .slice(0, 10)
      .map((r) => ({
        request_id: r.request_id,
        field: r.field,
        why: r.why.slice(0, TEXT_MAX),
        options: r.options,
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
  })
}

/**
 * The stored rows as `FactValue`s. A row the contract now refuses, such as
 * hours stored before the rule that they close after they open, is left out
 * and named, so one old row never fails the list.
 */
export function toCosFacts(rows: FactRecord[]): {
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
  if (!revision) return refused(notFound("assignment"))
  return GetPreviewOutput.parse({
    outcome: "ready",
    assignment_id: id,
    version: revision.version,
    expires_at: link.expires_at,
  })
}

/** The owner's change, started as `/changes` starts it, keyed by the approval. */
export async function requestChange(
  { env, kit, owner }: ToolContext,
  input: OwnerChangeRequest,
  approvalId: string
): Promise<RequestChangeOutput> {
  const response = await startChange(env, kit, owner, input.text, approvalId)
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
    message: "No build is waiting on that question.",
    detail: {},
  })

/**
 * The owner's answer, sent through the orchestrator's `/answer` keyed by the
 * approval. The build is the one that asked, and it has to be waiting on this
 * question (`waitedOn`), answered or not, since the orchestrator replays a
 * repeat and refuses a change of mind. Any other question, another org's
 * included, is refused here and never reaches the orchestrator.
 *
 * ponytail: the asking build is found by scanning the org's
 * `information.requested` events for the id; an expression index on
 * `payload->>'request_id'` when that shows in the slow log.
 */
export async function answerQuestion(
  { env, kit, owner }: ToolContext,
  input: AnswerQuestionInput,
  approvalId: string
): Promise<AnswerQuestionOutput> {
  const asking = await kit.withOrg({ orgId: owner.orgId }, async (db) => {
    const [asked] = await db
      .select({ assignmentId: events.assignmentId })
      .from(events)
      .where(
        sql`${events.type} = 'information.requested' and ${events.payload}->>'request_id' = ${input.request_id}`
      )
      .limit(1)
    if (!asked?.assignmentId) return null
    const [waited] = await waitedOn(db, asked.assignmentId)
    return waited?.request.request_id === input.request_id
      ? asked.assignmentId
      : null
  })
  if (!asking) return refused(noQuestion())
  const answered = relay(
    await bridge(env, owner, `/${asking}/answer`, {
      body: { request_id: input.request_id, value: input.value },
      key: approvalId,
    }),
    InformationAnswer.parse
  )
  if (!answered.ok) return refused(answered)
  const receipt = InformationAnswer.parse(await answered.json())
  return { outcome: "answered", request_id: receipt.request_id }
}
