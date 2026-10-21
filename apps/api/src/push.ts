import {
  idempotencyKey,
  PushConfig,
  PushSubscribed,
  PushSubscribeRequest,
  Uuid,
} from "@workspace/contracts"
import {
  addPushSubscription,
  eq,
  pushSubscriptions,
  type Tenancy,
} from "@workspace/db"
import type { Owner } from "./changes.ts"
import { isOrgOwner } from "./domain-buy.ts"
import { failure, invalid, keyMissing, readBody } from "./http.ts"
import { ownerStaffId } from "./staff.ts"

/**
 * Where a browser is told to receive the owner's pushes (ADR-043). Only the
 * org's owner subscribes: a push carries the owner's chat, and the sender
 * posts to every subscription the org holds. The address a browser hands over
 * is checked against the push services' hosts by `PushSubscribeRequest`.
 */

const refused = (code: string, message: string, status = 403) =>
  failure(status, {
    class: status === 404 ? "resource" : "permission",
    code,
    message,
    detail: {},
  })

/**
 * `GET /push/config`, `POST /push/subscriptions` and
 * `DELETE /push/subscriptions/{id}`.
 */
export async function pushRoute(
  request: Request,
  env: Pick<Env, "VAPID_PUBLIC_KEY">,
  kit: Tenancy,
  owner: Owner
): Promise<Response | null> {
  const { pathname } = new URL(request.url)
  const method = request.method
  if (pathname === "/push/config" && method === "GET") {
    return Response.json(
      PushConfig.parse({ public_key: env.VAPID_PUBLIC_KEY || null })
    )
  }
  const [, , , id = ""] = pathname.split("/")
  if (method !== (id ? "DELETE" : "POST")) return null
  if (!idempotencyKey(request)) return keyMissing()
  if (!(await isOrgOwner(kit, owner))) {
    return refused("push.not_owner", "Only the owner can set up notifications.")
  }
  if (id) {
    const [gone] = Uuid.safeParse(id).success
      ? await kit.withOrg({ orgId: owner.orgId }, (db) =>
          db
            .delete(pushSubscriptions)
            .where(eq(pushSubscriptions.id, id))
            .returning({ id: pushSubscriptions.id })
        )
      : []
    return gone
      ? new Response(null, { status: 204 })
      : refused(
          "push.not_found",
          "No notification setup with that id in this business.",
          404
        )
  }
  const parsed = PushSubscribeRequest.safeParse(await readBody(request))
  if (!parsed.success) return invalid(parsed.error.issues)
  const { endpoint, keys } = parsed.data
  const added = await kit.withOrg(
    { orgId: owner.orgId, workosUserId: owner.session.workosUserId },
    async (db) =>
      addPushSubscription(db, {
        orgId: owner.orgId,
        staffId: (await ownerStaffId(db, {
          orgId: owner.orgId,
          workosUserId: owner.session.workosUserId,
          ownerName: owner.session.name ?? owner.session.email,
        })) as string,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
      })
  )
  return Response.json(PushSubscribed.parse({ id: added }), { status: 201 })
}
