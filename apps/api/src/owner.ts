import {
  AnswerRequest,
  ApprovalDecision,
  Assignment,
  DecisionRequest,
  FactList,
  InformationAnswer,
  idempotencyKey,
  OwnerChangeRequest,
  PHOTO_PATH,
  PreviewLink,
  SetFactsRequest,
} from "@workspace/contracts"
import {
  approvals,
  assignments,
  failureCode,
  postChangeAsked,
  type Tenancy,
} from "@workspace/db"
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
import { memoryRoute } from "./cos/memory.ts"
import { removal } from "./cos/tools.ts"
import { checkout, isOrgOwner, purchaseStatus } from "./domain-buy.ts"
import { googleConnect } from "./google.ts"
import { failure, invalid, keyMissing, readBody } from "./http.ts"
import { drawLogos, keepLogo, readLogos } from "./logo.ts"
import { pushRoute } from "./push.ts"
import { reminderRoute } from "./reminders.ts"
import { logoPalettes, paletteFromImage, reviewPhotos } from "./vision.ts"
import { readActivity, readFacts, unchanged } from "./workspace.ts"
import { readTaggedWorkspace } from "./workspace-tag.ts"

/** `POST /logos/{id}/keep`, the id a UUID: a drawn variant's or an uploaded asset's. */
const LOGO_KEEP_PATH =
  /^\/logos\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/keep$/

/**
 * The owner's routes. The org is the one `index.ts` resolved from the sealed
 * session, and nothing here reads an org, a user or a session from the
 * request. Reads and fact writes run here under `withOrg`; anything that
 * touches a Workflow, the sandbox or a preview key crosses the ORCHESTRATOR
 * binding to `OwnerApi` (architect ruling 3).
 */

/** The routes `ownerRoute` answers, for `index.ts` to resolve an org before. */
export const OWNER_PATH =
  /^\/(workspace|facts|assets(\/review)?|photos\/[^/]+|logos(\/[^/]+\/keep)?|palettes\/from-(image|logo)|changes|activity|builds\/[^/]+\/(answer|cancel|preview)|approvals\/[^/]+\/decision|conversations(\/[^/]+(\/(messages|feedback))?)?|reminders(\/[^/]+)?|memory(\/(undo|review))?|push\/(config|subscriptions(\/[^/]+)?)|domains\/[^/]+(\/checkout)?|google\/(connect|disconnect)|chat)$/

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
  const { text, change_kind, chat } = parsed.data
  const response = await startChange(env, kit, owner, text, key, change_kind)
  if (chat && response.ok) {
    // The change has started: a note that cannot be posted must not undo it.
    await postChangeAsked(kit, {
      orgId: owner.orgId,
      key,
      text,
      conversationId: chat.conversation_id,
    }).catch((error: unknown) =>
      console.error(
        JSON.stringify({
          code: "changes.post_failed",
          error: failureCode(error),
        })
      )
    )
  }
  return response
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
  let body: AnswerRequest | undefined
  if (action === "answer") {
    const parsed = AnswerRequest.safeParse(await readBody(request))
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
  // `/cancel` answers the id and the state it settled in.
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

/** `DELETE /domains/{name}`: the owner takes a connected domain off the site (`removal`). */
async function removeDomain(
  request: Request,
  env: Env,
  kit: Tenancy,
  owner: Owner,
  name: string
) {
  const key = idempotencyKey(request)
  if (!key) return keyMissing()
  return removal({ env, kit, owner }, name, key)
}

/**
 * `POST /google/disconnect`: the owner ends the Google connection. The
 * orchestrator revokes the grant at Google and deletes the org's search data
 * (`/search/disconnect`); this only checks the role and bridges.
 */
async function disconnectGoogle(
  request: Request,
  env: Env,
  kit: Tenancy,
  owner: Owner
) {
  if (!(await isOrgOwner(kit, owner))) {
    return failure(403, {
      class: "permission",
      code: "google.not_owner",
      message: "Only the owner can disconnect Google.",
      detail: {},
    })
  }
  const result = await bridge(env, owner, "/search/disconnect", {
    key: idempotencyKey(request),
  })
  if (result.status === 204) return new Response(null, { status: 204 })
  return relay(result, (body) => body)
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
    const { body, etag } = await readTaggedWorkspace(kit, owner.orgId, env)
    const headers = { etag, "cache-control": "private, no-cache" }
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
  if (pathname === "/assets/review" && method === "POST") {
    return reviewPhotos(request, env, kit, owner)
  }
  if (PHOTO_PATH.test(pathname) && method === "GET") {
    return readPhoto(env, owner, pathname.slice("/photos/".length))
  }
  if (pathname === "/logos" && method === "POST") {
    return drawLogos(request, env, kit, owner)
  }
  if (pathname === "/logos" && method === "GET") {
    return readLogos(request, env, owner)
  }
  const kept = LOGO_KEEP_PATH.exec(pathname)
  if (kept && method === "POST") {
    return keepLogo(request, env, kit, owner, kept[1] as string)
  }
  if (pathname === "/palettes/from-image" && method === "POST") {
    return paletteFromImage(request, env, owner)
  }
  if (pathname === "/palettes/from-logo" && method === "POST") {
    return logoPalettes(request, env, kit, owner)
  }
  if (pathname === "/changes" && method === "POST") {
    return requestChange(request, env, kit, owner)
  }
  if (pathname === "/google/disconnect" && method === "POST") {
    return disconnectGoogle(request, env, kit, owner)
  }
  if (pathname === "/chat" && method === "POST") {
    return chat(request, env, kit, owner, { waitUntil })
  }
  if (pathname === "/google/connect" && method === "POST") {
    return googleConnect(request, env, kit, owner)
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
  if (noun === "reminders") return reminderRoute(request, env, kit, owner, id)
  if (noun === "memory") return memoryRoute(request, kit, owner)
  if (noun === "push") return pushRoute(request, env, kit, owner)
  if (noun === "domains" && method === "DELETE" && !action) {
    return removeDomain(request, env, kit, owner, id)
  }
  if (noun === "domains" && method === "POST" && action === "checkout") {
    return checkout(request, env, kit, owner, id)
  }
  if (noun === "domains" && method === "GET" && !action) {
    return purchaseStatus(kit, owner, id)
  }
  if (noun === "approvals" && method === "POST") {
    return decide(request, env, kit, owner, id)
  }
  return null
}
