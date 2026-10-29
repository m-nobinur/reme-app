import { ErrorEnvelope } from "@workspace/contracts"
import {
  conversationMessages,
  conversations,
  domains,
  memberships,
  searchConnections,
  sql,
  type Tenancy,
  tenancy,
} from "@workspace/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { connectGoogle } from "../src/google.ts"
import {
  type Owner,
  owner,
  type Stub,
  stubOrchestrator,
} from "./owner-fixture.ts"
import { stubJwksFetch } from "./sealed-session.ts"

/**
 * `POST /google/connect` and `connect_google` on a live connection, the
 * orchestrator stood in for: the owner only, the body checked before the
 * binding, and the orchestrator's answers passed back as the web reads them.
 */

const url = process.env.DATABASE_URL
const BODY = {
  code: "4/code",
  verifier: "v".repeat(43),
  redirect_uri: "https://staging.remeai.co.uk/api/google/callback",
}
const WEB = "https://staging.remeai.co.uk"

describe.skipIf(!url)("connecting Google through the api", () => {
  const kit: Tenancy = tenancy(url as string, { max: 3 })
  let me: Owner
  let member: Owner

  beforeAll(async () => {
    globalThis.fetch = stubJwksFetch() as typeof fetch
    me = await owner(kit, url as string, "google")
    member = await owner(kit, url as string, "google-member")
    await kit.withOrg({ orgId: member.orgId }, (db) =>
      db
        .update(memberships)
        .set({ role: "member" })
        .where(sql`${memberships.orgId} = ${member.orgId}`)
    )
  })
  afterAll(() => kit.close())

  const connect = (who: Owner, stub: Stub, body: unknown = BODY) =>
    who.call(stub, "/google/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })

  it("hands the owner's code to the orchestrator and answers 204", async () => {
    const stub = stubOrchestrator(() => new Response(null, { status: 204 }))
    const answered = await connect(me, stub)
    expect(answered.status).toBe(204)
    expect(stub.calls).toHaveLength(1)
    expect(new URL(stub.calls[0]?.request.url ?? "").pathname).toBe(
      "/assignments/search/connect"
    )
    expect(stub.calls[0]?.body).toEqual(BODY)
  })

  it("passes a partial consent back as 422 scopes_missing", async () => {
    const stub = stubOrchestrator(() =>
      Response.json(
        {
          class: "validation",
          code: "search.scopes_missing",
          message: "Both boxes.",
          detail: {},
          occurred_at: new Date().toISOString(),
        },
        { status: 422 }
      )
    )
    const answered = await connect(me, stub)
    expect(answered.status).toBe(422)
    expect(ErrorEnvelope.parse(await answered.json()).code).toContain(
      "scopes_missing"
    )
  })

  it("refuses a member who is not the owner, and a body off the contract, before the binding", async () => {
    const stub = stubOrchestrator()
    const notOwner = await connect(member, stub)
    expect(notOwner.status).toBe(403)
    expect(ErrorEnvelope.parse(await notOwner.json()).code).toBe(
      "search.not_owner"
    )
    const bad = await connect(me, stub, { ...BODY, verifier: "short" })
    expect(bad.status).toBe(400)
    expect(stub.calls).toEqual([])
  })

  it("says how a callback ended once in the chat, per attempt, and only for the owner", async () => {
    const result = (who: Owner, body: unknown) =>
      who.call(stubOrchestrator(), "/google/result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    const posted = () =>
      kit.withOrg({ orgId: me.orgId }, (db) =>
        db.select({ id: conversationMessages.id }).from(conversationMessages)
      )
    await kit.withOrg({ orgId: me.orgId }, (db) =>
      db.insert(conversations).values({
        orgId: me.orgId,
        kind: "assistant",
        createdByStaffId: me.chiefId,
      })
    )
    const before = (await posted()).length
    const attempt = { attempt: "state-1", result: "failed" }
    expect((await result(me, attempt)).status).toBe(204)
    expect((await result(me, attempt)).status).toBe(204)
    expect(await posted()).toHaveLength(before + 1)
    await result(me, { attempt: "state-2", result: "scopes_missing" })
    expect(await posted()).toHaveLength(before + 2)
    await result(me, { attempt: "state-3", result: "connected" })
    await result(me, { attempt: "state-4", result: "cancelled" })
    expect(await posted()).toHaveLength(before + 4)
    expect((await result(member, attempt)).status).toBe(403)
    expect((await result(me, { attempt: "", result: "failed" })).status).toBe(
      400
    )
  })

  it("connect_google: off, waiting for a live domain, the consent link, the connected account, or refused for a member", async () => {
    const as = (who: Owner) => ({
      orgId: who.orgId,
      session: { workosUserId: who.workosUserId } as never,
    })
    const env = { GOOGLE_CLIENT_ID: "client", WEB_ORIGIN: WEB } as Env
    expect(
      await connectGoogle(
        { env: { WEB_ORIGIN: WEB } as Env, kit, owner: as(me) },
        {}
      )
    ).toEqual({ available: false })
    // Google learns the address customers keep, so no link before a live domain.
    expect(await connectGoogle({ env, kit, owner: as(me) }, {})).toMatchObject({
      outcome: "refused",
      error: { code: "search.needs_domain" },
    })
    const name = `g${crypto.randomUUID().slice(0, 8)}.co.uk`
    await kit.withOrg({ orgId: me.orgId }, (db) =>
      db.insert(domains).values({
        orgId: me.orgId,
        siteId: me.orgId,
        name,
        primaryHost: `www.${name}`,
        origin: "connected",
        method: "records",
        state: "active",
      })
    )
    expect(await connectGoogle({ env, kit, owner: as(me) }, {})).toEqual({
      url: `${WEB}/api/google/start`,
    })
    expect(
      await connectGoogle({ env, kit, owner: as(member) }, {})
    ).toMatchObject({
      outcome: "refused",
      error: { code: "search.not_owner" },
    })
    await kit.withOrg({ orgId: me.orgId }, (db) =>
      db.insert(searchConnections).values({
        orgId: me.orgId,
        googleEmail: "owner@example.test",
        refreshToken: "v1.aXY.Y3Q",
        state: "active",
      })
    )
    expect(await connectGoogle({ env, kit, owner: as(me) }, {})).toEqual({
      connected: true,
      email: "owner@example.test",
    })
  })

  // Runs after the case above saved a connection for `me`.
  it("answers a connect that failed after its token was saved as connected, and never says it didn't connect", async () => {
    const stub = stubOrchestrator(() =>
      Response.json(
        {
          class: "transient",
          code: "internal",
          message: "x",
          detail: {},
          occurred_at: new Date().toISOString(),
        },
        { status: 500 }
      )
    )
    expect((await connect(me, stub)).status).toBe(204)
    const sent = await me.call(stubOrchestrator(), "/google/result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attempt: "state-saved", result: "failed" }),
    })
    expect(sent.status).toBe(204)
    const rows = await kit.withOrg({ orgId: me.orgId }, (db) =>
      db
        .select({ content: conversationMessages.content })
        .from(conversationMessages)
    )
    const texts = JSON.stringify(rows.at(-1)?.content)
    expect(texts).toContain("Google is connected")
    expect(texts).not.toContain("didn't connect")
  })
})
