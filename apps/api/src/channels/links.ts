import {
  ChannelLinkPatch,
  ChannelLinkStarted,
  ChannelsState,
  idempotencyKey,
  ChannelLink as LinkShape,
  Uuid,
} from "@workspace/contracts"
import {
  and,
  channelLinkCodes,
  channelLinks,
  eq,
  isNull,
  type OrgScopedDb,
  type Tenancy,
  users,
  whatsappAccounts,
} from "@workspace/db"
import type { Owner } from "../changes.ts"
import { isOrgOwner } from "../domain-buy.ts"
import { failure, invalid, keyMissing, readBody } from "../http.ts"
import { hashCode } from "./token.ts"
import { signupRoute } from "./whatsapp/signup.ts"

/**
 * The owner's side of messaging channels: what is linked, a one-time code to
 * link a phone, and ending a link. Links shown are the caller's own chats.
 * `WHATSAPP_ENABLED` off is a 404 on every route here.
 */

const CODE_TTL_MS = 10 * 60 * 1000

const refused = (status: number, code: string, message: string) =>
  failure(status, {
    class: status === 404 ? "resource" : "permission",
    code,
    message,
    detail: {},
  })

const asLink = (row: typeof channelLinks.$inferSelect) =>
  LinkShape.parse({
    id: row.id,
    kind: "whatsapp",
    label: row.label,
    connected_at: row.createdAt.toISOString(),
    updates: row.updates,
  })

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

/** `GET /channels`, `POST /channels/whatsapp/link`, `PATCH` and `DELETE /channels/links/{id}`. */
export async function channelsRoute(
  request: Request,
  env: Parameters<typeof signupRoute>[1] & Pick<Env, "WHATSAPP_ENABLED">,
  kit: Tenancy,
  owner: Owner
): Promise<Response | null> {
  if (env.WHATSAPP_ENABLED !== "1") {
    return refused(404, "channels.not_found", "No such route.")
  }
  const { pathname } = new URL(request.url)
  const method = request.method
  const [, , noun = "", id = ""] = pathname.split("/")
  const route =
    pathname === "/channels" && method === "GET"
      ? "list"
      : pathname === "/channels/whatsapp/link" && method === "POST"
        ? "link"
        : pathname === "/channels/whatsapp/signup" &&
            (method === "GET" || method === "POST")
          ? "signup"
          : noun === "links" &&
              id &&
              (method === "PATCH" || method === "DELETE")
            ? method
            : null
  if (!route) return null
  const read = route === "list" || (route === "signup" && method === "GET")
  if (!(read || idempotencyKey(request))) return keyMissing()
  if (!(await isOrgOwner(kit, owner))) {
    return refused(
      403,
      "channels.not_owner",
      "Only the owner can manage messaging channels."
    )
  }
  if (route === "signup") return signupRoute(request, env, kit, owner)
  const ctx = {
    orgId: owner.orgId,
    workosUserId: owner.session.workosUserId,
  }
  const me = async (db: OrgScopedDb) => {
    const [person] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.workosUserId, owner.session.workosUserId))
    return (person as { id: string }).id
  }
  const mine = async (db: OrgScopedDb) =>
    and(
      eq(channelLinks.userId, await me(db)),
      isNull(channelLinks.revokedAt),
      id ? eq(channelLinks.id, id) : undefined
    )

  if (route === "list") {
    return kit.withOrg(ctx, async (db) => {
      const [account] = await db.select().from(whatsappAccounts)
      const links = await db
        .select()
        .from(channelLinks)
        .where(await mine(db))
        .orderBy(channelLinks.createdAt)
      return Response.json(
        ChannelsState.parse({
          whatsapp: {
            available: true,
            account: account
              ? {
                  display_number: account.displayNumber,
                  display_name: account.displayName,
                  source: account.source,
                  coexistence: account.coexistence,
                  status: account.status,
                }
              : null,
            links: links.map(asLink),
          },
        })
      )
    })
  }

  if (route === "link") {
    const code = base64url(crypto.getRandomValues(new Uint8Array(24)))
    const hash = await hashCode(code)
    const expiresAt = new Date(Date.now() + CODE_TTL_MS)
    const number = await kit.withOrg(ctx, async (db) => {
      const [account] = await db
        .select({ number: whatsappAccounts.displayNumber })
        .from(whatsappAccounts)
        .where(eq(whatsappAccounts.status, "active"))
      if (!account) return null
      const userId = await me(db)
      await db
        .update(channelLinkCodes)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(channelLinkCodes.userId, userId),
            eq(channelLinkCodes.kind, "whatsapp"),
            isNull(channelLinkCodes.usedAt)
          )
        )
      await db.insert(channelLinkCodes).values({
        hash,
        orgId: owner.orgId,
        userId,
        kind: "whatsapp",
        expiresAt,
      })
      return account.number
    })
    if (!number) {
      return refused(
        409,
        "channels.no_account",
        "Connect a WhatsApp number first."
      )
    }
    const text = encodeURIComponent(`Connect Reme ${code}`)
    return Response.json(
      ChannelLinkStarted.parse({
        kind: "whatsapp",
        url: `https://wa.me/${number.slice(1)}?text=${text}`,
        expires_at: expiresAt.toISOString(),
      }),
      { status: 201 }
    )
  }

  const gone = () =>
    refused(404, "channels.not_found", "No chat with that id in your account.")
  if (!Uuid.safeParse(id).success) return gone()

  if (route === "PATCH") {
    const parsed = ChannelLinkPatch.safeParse(await readBody(request))
    if (!parsed.success) return invalid(parsed.error.issues)
    const [row] = await kit.withOrg(ctx, async (db) =>
      db
        .update(channelLinks)
        .set({ updates: parsed.data.updates })
        .where(await mine(db))
        .returning()
    )
    return row ? Response.json(asLink(row)) : gone()
  }

  const [row] = await kit.withOrg(ctx, async (db) =>
    db
      .update(channelLinks)
      .set({ revokedAt: new Date() })
      .where(await mine(db))
      .returning({ id: channelLinks.id })
  )
  return row ? new Response(null, { status: 204 }) : gone()
}
