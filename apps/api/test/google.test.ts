import { ErrorEnvelope, SKIP_DOMAIN } from "@workspace/contracts"
import {
  conversationMessages,
  conversations,
  domains,
  memberships,
  openTask,
  searchConnections,
  sql,
  type Tenancy,
  tenancy,
} from "@workspace/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { turnNotes } from "../src/chat.ts"
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

  it("connect_google: off, waiting for a domain of the owner's own, the consent link, the connected account, or refused for a member", async () => {
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
    // Google learns the address customers keep, so no link before the owner
    // has a domain of their own; one still connecting is enough, since the
    // first publish or its activation hands it to Google.
    expect(await connectGoogle({ env, kit, owner: as(me) }, {})).toMatchObject({
      outcome: "refused",
      error: { code: "search.needs_domain" },
    })
    // Or the free address, once the owner put the domain off or said no.
    for (const state of ["later", "declined"]) {
      await kit.withOrg({ orgId: me.orgId }, async (db) => {
        await openTask(db, me.orgId, "address")
        await db.execute(
          sql`update owner_tasks set state = ${state}::task_state, later_until = ${state === "later" ? sql`now() + interval '7 days'` : null} where kind = 'address'`
        )
      })
      expect(await connectGoogle({ env, kit, owner: as(me) }, {})).toEqual({
        url: `${WEB}/api/google/start`,
      })
    }
    await kit.withOrg({ orgId: me.orgId }, (db) =>
      db.execute(sql`delete from owner_tasks where kind = 'address'`)
    )
    const name = `g${crypto.randomUUID().slice(0, 8)}.co.uk`
    await kit.withOrg({ orgId: me.orgId }, (db) =>
      db.insert(domains).values({
        orgId: me.orgId,
        siteId: me.orgId,
        name,
        primaryHost: `www.${name}`,
        origin: "connected",
        method: "records",
        state: "awaiting_dns",
      })
    )
    expect(await connectGoogle({ env, kit, owner: as(me) }, {})).toEqual({
      url: `${WEB}/api/google/start`,
    })
    // Local dev's app is plain http on localhost; a real host on http is a
    // misconfigured environment, which offers no link rather than an http one.
    const local = {
      ...env,
      WEB_ORIGIN: "http://localhost:3000",
    } as unknown as Env
    expect(await connectGoogle({ env: local, kit, owner: as(me) }, {})).toEqual(
      {
        url: "http://localhost:3000/api/google/start",
      }
    )
    const plain = {
      ...env,
      WEB_ORIGIN: "http://staging.remeai.co.uk",
    } as unknown as Env
    expect(await connectGoogle({ env: plain, kit, owner: as(me) }, {})).toEqual(
      {
        available: false,
      }
    )
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
        .orderBy(conversationMessages.seq)
    )
    const texts = JSON.stringify(rows.at(-1)?.content)
    // Not published yet: the website goes to Google the moment it is live.
    expect(texts).toContain(
      "You're connected to Google. The moment your website goes live, I'll add it"
    )
    expect(texts).not.toContain("didn't connect")
  })

  it("after the domain is put off in words, loads Google's connect as the next step and remembers it was suggested", async () => {
    const next = await owner(kit, url as string, "google-next")
    const conversation = crypto.randomUUID()
    const workspace = {
      site: { host: null, live_version: null },
      builds: [],
      questions: [],
      approvals: [{ version: 1, expires_at: new Date().toISOString() }],
      missing_facts: [],
      tasks: [],
    }
    const notes = (said: string) =>
      kit.withOrg({ orgId: next.orgId }, (db) =>
        turnNotes(db, conversation, workspace, null, false, said)
      )
    const skipped = await notes(`${SKIP_DOMAIN} and use the free address`)
    expect(skipped.skills.map((s) => `${s.name}/${s.part ?? ""}`)).toEqual([
      "web-address/",
      "google-search/",
      "google-search/connect",
    ])
    expect(skipped.skillLine).toBe("Lining up your next step")
    const offers = () =>
      kit.withOrg({ orgId: next.orgId }, (db) =>
        db.execute<{ n: number }>(
          sql`select count(*)::int as n from deliveries where key like 'journey:%:google_offer:%'`
        )
      )
    expect((await offers())[0]?.n).toBe(1)
    // The next message in the sitting brings nothing back.
    const after = await notes("Thanks")
    expect(after.lines.join("\n")).not.toMatch(/still not connected/)
    expect((await offers())[0]?.n).toBe(1)
  })
})
