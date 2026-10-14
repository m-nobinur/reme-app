import {
  AnswerRequest,
  ApprovalDecision,
  Assignment,
  BlueprintReviewOutput,
  DecisionRequest,
  FactList,
  InformationAnswer,
  idempotencyKey,
  OwnerChangeRequest,
  PHOTO_PATH,
  PreviewLink,
  SetFactsRequest,
} from "@workspace/contracts"
import { approvals, assignments, type Tenancy } from "@workspace/db"
import { readPhoto, uploadAssets } from "./assets.ts"
import {
  bridge,
  holds,
  notFound,
  type Owner,
  relay,
  startChange,
  stateFacts,
} from "./changes.ts"
import { chat } from "./chat.ts"
import { conversationRoute } from "./conversations.ts"
import { failure, invalid, keyMissing, readBody } from "./http.ts"
import { reminderRoute } from "./reminders.ts"
import {
  etag,
  readActivity,
  readFacts,
  readWorkspace,
  unchanged,
} from "./workspace.ts"

/**
 * The owner's routes. The org is the one `index.ts` resolved from the sealed
 * session, and nothing here reads an org, a user or a session from the
 * request. Reads and fact writes run here under `withOrg`; anything that
 * touches a Workflow, the sandbox or a preview key crosses the ORCHESTRATOR
 * binding to `OwnerApi` (architect ruling 3).
 */

/** The routes `ownerRoute` answers, for `index.ts` to resolve an org before. */
export const OWNER_PATH =
  /^\/(workspace|facts|assets|photos\/[^/]+|changes|activity|builds\/[^/]+\/(answer|blueprint|cancel|preview)|approvals\/[^/]+\/decision|conversations(\/[^/]+(\/(messages|feedback))?)?|reminders(\/[^/]+)?|chat)$/

async function setFacts(request: Request, kit: Tenancy, owner: Owner) {
  if (!idempotencyKey(request)) return keyMissing()
  const parsed = SetFactsRequest.safeParse(await readBody(request))
  if (!parsed.success) return invalid(parsed.error.issues)
  const keys = parsed.data.facts.map((fact) => fact.key)
  if (new Set(keys).size !== keys.length) {
    return failure(400, {
      class: "validation",
      code: "facts.duplicate_key",
      message: "Each fact key appears once in a request.",
      detail: { keys },
    })
  }
  const list = await kit.withOrg(
    { orgId: owner.orgId, workosUserId: owner.session.workosUserId },
    async (db) => {
      await stateFacts(db, owner, parsed.data.facts)
      return readFacts(db)
    }
  )
  return Response.json(FactList.parse({ facts: list }))
}

async function requestChange(
  request: Request,
  env: Env,
  kit: Tenancy,
  owner: Owner
) {
  const key = idempotencyKey(request)
  if (!key) return keyMissing()
  const parsed = OwnerChangeRequest.safeParse(await readBody(request))
  if (!parsed.success) return invalid(parsed.error.issues)
  const { text, change_kind } = parsed.data
  return startChange(env, kit, owner, text, key, change_kind)
}

async function buildAction(
  request: Request,
  env: Env,
  kit: Tenancy,
  owner: Owner,
  id: string,
  action: string
) {
  const method = request.method
  if ((action === "preview") !== (method === "GET")) return null
  const key = idempotencyKey(request)
  if (method === "POST" && !key) return keyMissing()
  let body: AnswerRequest | BlueprintReviewOutput | undefined
  if (action === "answer" || action === "blueprint") {
    const parsed = (
      action === "answer" ? AnswerRequest : BlueprintReviewOutput
    ).safeParse(await readBody(request))
    if (!parsed.success) return invalid(parsed.error.issues)
    body = parsed.data
  }
  // Which question an answer may reach, and whether it repeats one already
  // given, is the orchestrator's to say, under the build's row lock. Whether
  // the org holds the build is checked here, so another org's id never
  // reaches the binding (the tenancy gate holds that).
  const found = await holds(kit, owner.orgId, assignments, id)
  if (!found) return notFound("assignment")
  const result = await bridge(env, owner, `/${id}/${action}`, {
    method: method === "GET" ? "GET" : "POST",
    body,
    key,
  })
  if (action === "answer") return relay(result, InformationAnswer.parse)
  if (action === "preview") return relay(result, PreviewLink.parse)
  // `/cancel` and `/blueprint` (the plan's decision, which the orchestrator turns
  // into `blueprint.decided`) answer the id and the state it settled in.
  return relay(result, (b) =>
    Assignment.pick({ assignment_id: true, state: true }).parse(b)
  )
}

async function decide(
  request: Request,
  env: Env,
  kit: Tenancy,
  owner: Owner,
  id: string
) {
  const key = idempotencyKey(request)
  if (!key) return keyMissing()
  const parsed = DecisionRequest.safeParse(await readBody(request))
  if (!parsed.success) return invalid(parsed.error.issues)
  const approval = await holds(kit, owner.orgId, approvals, id)
  if (!approval?.assignmentId) return notFound("approval")
  const verb = parsed.data.decision === "approved" ? "approve" : "reject"
  const result = await bridge(env, owner, `/${approval.assignmentId}/${verb}`, {
    body: { revision_id: parsed.data.revision_id },
    key,
  })
  // The console's publish handle stays on the console's side of the binding.
  return relay(result, (b) => {
    const { workflow_instance_id: _, ...decision } = b as Record<
      string,
      unknown
    >
    return ApprovalDecision.parse(decision)
  })
}

export async function ownerRoute(
  request: Request,
  env: Env,
  kit: Tenancy,
  owner: Owner,
  waitUntil: (promise: Promise<unknown>) => void
): Promise<Response | null> {
  const { pathname } = new URL(request.url)
  const method = request.method
  if (pathname === "/workspace" && method === "GET") {
    const status = await readWorkspace(kit, owner.orgId, env)
    const body = JSON.stringify(status)
    const headers = {
      etag: await etag(body),
      "cache-control": "private, no-cache",
    }
    if (unchanged(request.headers.get("if-none-match"), headers.etag)) {
      return new Response(null, { status: 304, headers })
    }
    return new Response(body, {
      headers: { ...headers, "content-type": "application/json" },
    })
  }
  if (pathname === "/facts" && method === "GET") {
    const facts = await kit.withOrg({ orgId: owner.orgId }, readFacts)
    return Response.json(FactList.parse({ facts }))
  }
  if (pathname === "/facts" && method === "POST") {
    return setFacts(request, kit, owner)
  }
  if (pathname === "/assets" && method === "POST") {
    return uploadAssets(request, env, kit, owner)
  }
  if (PHOTO_PATH.test(pathname) && method === "GET") {
    return readPhoto(env, owner, pathname.slice("/photos/".length))
  }
  if (pathname === "/changes" && method === "POST") {
    return requestChange(request, env, kit, owner)
  }
  if (pathname === "/chat" && method === "POST") {
    return chat(request, env, kit, owner, { waitUntil })
  }
  if (pathname === "/activity" && method === "GET") {
    return Response.json(await readActivity(kit, owner.orgId))
  }
  const [, noun, id = "", action = ""] = pathname.split("/")
  if (noun === "builds") {
    return buildAction(request, env, kit, owner, id, action)
  }
  if (noun === "conversations") {
    return conversationRoute(request, kit, owner, id, action)
  }
  if (noun === "reminders") return reminderRoute(request, kit, owner, id)
  if (noun === "approvals" && method === "POST") {
    return decide(request, env, kit, owner, id)
  }
  return null
}
