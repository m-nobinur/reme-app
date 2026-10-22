import { siteHost } from "@workspace/contracts"
import {
  deployments,
  domains,
  eq,
  events,
  orgs,
  searchConnections,
  searchProperties,
  sql,
} from "@workspace/db"
import { afterEach, describe, expect, it, vi } from "vitest"
import { openToken } from "../src/google.ts"
import {
  accessToken,
  connectGoogle,
  ownProperty,
  placeToken,
  searchInstanceId,
} from "../src/search.ts"
import { freshOrg } from "./fixture.ts"
import { kit, previewed, SUFFIX, storage } from "./site.ts"

vi.mock("../src/container.ts", () => ({
  RemeSandbox: class {},
  SandboxEgress: class {},
  SandboxPool: class {},
}))
vi.mock("../src/sandbox.ts", () => ({}))
vi.mock("../src/agents/developer.ts", () => ({ Developer: {} }))

/**
 * The connect route and the org's `site_url` guard against a real database,
 * with Google's token and revoke endpoints stood in for. Skipped without
 * DATABASE_URL, like the publish suite.
 */

const url = process.env.DATABASE_URL
const SCOPES =
  "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/webmasters https://www.googleapis.com/auth/siteverification.verify_only"
const BODY = {
  code: "4/code",
  verifier: "v".repeat(43),
  redirect_uri: "https://staging.remeai.co.uk/api/google/callback",
}

const idToken = (email: string) =>
  `h.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.s`

/** Google's token endpoint answering with `refresh` for `email`, and its revoke endpoint recording. */
function stubGoogle(refresh: string, email: string, scope = SCOPES) {
  const revoked: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const href = String(input)
      const form = new URLSearchParams(String(init?.body))
      if (href.endsWith("/revoke")) {
        revoked.push(form.get("token") ?? "")
        return new Response(null, { status: 200 })
      }
      if (form.get("grant_type") === "refresh_token") {
        return Response.json({ error: "invalid_grant" }, { status: 400 })
      }
      return Response.json({
        access_token: "ya29.access",
        expires_in: 3600,
        refresh_token: refresh,
        scope,
        id_token: idToken(email),
      })
    })
  )
  return revoked
}

function searchEnv() {
  const created: { id: string; params: unknown }[] = []
  const env = {
    HYPERDRIVE: { connectionString: url },
    SITE_HOST_SUFFIX: SUFFIX,
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_TOKEN_KEY: Buffer.from(
      crypto.getRandomValues(new Uint8Array(32))
    ).toString("base64"),
    SEARCHES: {
      create: async (options: { id: string; params: unknown }) => {
        created.push(options)
      },
    },
  } as unknown as Env
  return { env, created }
}

const connection = (orgId: string) =>
  kit
    .withOrg({ orgId }, (db) => db.select().from(searchConnections))
    .then((rows) => rows[0])

const typesOf = async (orgId: string) =>
  (
    await kit.withOrg({ orgId }, (db) =>
      db
        .select({ type: events.type })
        .from(events)
        .where(sql`${events.type} like 'search.%'`)
        // Unordered, Postgres returned these either way round in the gate.
        .orderBy(events.recordedAt)
    )
  ).map((e) => e.type)

afterEach(() => vi.unstubAllGlobals())

/** An org with a live site, and the free subdomain it holds. */
async function published() {
  const site = await previewed()
  const orgId = site.orgId
  await kit.withOrg({ orgId }, (db) =>
    db.insert(deployments).values({
      orgId,
      siteId: orgId,
      revisionId: site.revisionId,
      configVersion: 1,
      kind: "rollback",
    })
  )
  const [org] = await kit.withOrg({ orgId }, (db) =>
    db.select({ slug: orgs.slug }).from(orgs).where(eq(orgs.id, orgId))
  )
  return { orgId, slug: siteHost(org?.slug ?? "", SUFFIX) }
}

describe.skipIf(!url)("connecting Google", () => {
  it("saves nothing when a scope was unticked", async () => {
    const orgId = await freshOrg(kit)
    stubGoogle(
      "1//refresh",
      "a@example.test",
      "openid https://www.googleapis.com/auth/webmasters"
    )
    const { env, created } = searchEnv()
    const result = await connectGoogle(
      env,
      kit,
      orgId,
      `user_probe_${orgId}`,
      BODY
    )
    expect(result).toMatchObject({
      refused: true,
      status: 422,
      code: "search.scopes_missing",
    })
    expect(await connection(orgId)).toBeUndefined()
    expect(await typesOf(orgId)).toEqual([])
    expect(created).toEqual([])
  })

  it("refuses a body that is not a callback's", async () => {
    const { env } = searchEnv()
    const result = await connectGoogle(env, kit, crypto.randomUUID(), "u", {
      ...BODY,
      verifier: "short",
    })
    expect(result).toMatchObject({ status: 400, code: "search.invalid" })
  })

  it("stores the refresh token sealed, audits it and starts one Workflow per live host", async () => {
    const site = await previewed()
    const orgId = site.orgId
    await kit.withOrg({ orgId }, (db) =>
      db.insert(deployments).values({
        orgId,
        siteId: orgId,
        revisionId: site.revisionId,
        configVersion: 1,
        kind: "rollback",
      })
    )
    const [org] = await kit.withOrg({ orgId }, (db) =>
      db.select({ slug: orgs.slug }).from(orgs).where(eq(orgs.id, orgId))
    )
    const host = siteHost(org?.slug ?? "", SUFFIX)
    stubGoogle("1//refresh-a", "a@example.test")
    const { env, created } = searchEnv()

    expect(await connectGoogle(env, kit, orgId, "nobody", BODY)).toEqual({
      email: "a@example.test",
    })
    const row = await connection(orgId)
    expect(row?.state).toBe("active")
    expect(row?.googleEmail).toBe("a@example.test")
    expect(row?.refreshToken).toMatch(/^v1\./)
    expect(row?.refreshToken).not.toContain("refresh-a")
    expect(await openToken(env, orgId, row?.refreshToken ?? "")).toBe(
      "1//refresh-a"
    )
    expect(await typesOf(orgId)).toEqual(["search.connected"])
    expect(created).toEqual([
      { id: searchInstanceId(orgId, host), params: { org_id: orgId, host } },
    ])
    expect(searchInstanceId(orgId, host)).toMatch(/^[A-Za-z0-9_-]{1,100}$/)
  })

  it("verifies only the host the site is served on, and starts it over on a reconnect", async () => {
    const { orgId, slug } = await published()
    const custom = `www.c-${orgId.slice(0, 8)}.example.test`
    // A host whose domain has gone, which may be another org's by now.
    const gone = `www.g-${orgId.slice(0, 8)}.example.test`
    const file = "google1a.html"
    const property = (host: string) => ({
      orgId,
      host,
      siteUrl: `https://${host}/`,
      kind: "url_prefix" as const,
      method: "file" as const,
      token: file,
      state: "verified" as const,
    })
    await kit.withOrg({ orgId }, async (db) => {
      await db.insert(domains).values({
        orgId,
        siteId: orgId,
        name: custom.slice(4),
        primaryHost: custom,
        origin: "connected",
        method: "records",
        state: "active",
      })
      // The slug host verified before the domain went live, and since redirecting.
      await db.insert(searchProperties).values([property(slug), property(gone)])
    })
    // Instances by id, with their status; a second create of one throws.
    const status = new Map([[searchInstanceId(orgId, slug), "complete"]])
    const log: string[] = []
    const { env } = searchEnv()
    Object.assign(env, {
      SEARCHES: {
        create: async ({ id }: { id: string }) => {
          if (status.has(id)) throw new Error("instance exists")
          status.set(id, "running")
          log.push(`create ${id}`)
        },
        get: async (id: string) => ({
          status: async () => ({ status: status.get(id) }),
          terminate: async () => {
            status.set(id, "terminated")
            log.push(`terminate ${id}`)
          },
          restart: async () => {
            status.set(id, "running")
            log.push(`restart ${id}`)
          },
        }),
      },
    })
    const domainRun = searchInstanceId(orgId, custom)
    stubGoogle("1//first", "a@example.test")
    await connectGoogle(env, kit, orgId, "nobody", BODY)
    expect(log).toEqual([`create ${domainRun}`])

    // Waiting out a verify backoff under the old account: ended, then run again.
    status.set(domainRun, "waiting")
    log.length = 0
    stubGoogle("1//second", "b@example.test")
    await connectGoogle(env, kit, orgId, "nobody", BODY)
    expect(log).toEqual([`terminate ${domainRun}`, `restart ${domainRun}`])

    // Finished under the old account: run again.
    status.set(domainRun, "complete")
    log.length = 0
    stubGoogle("1//third", "c@example.test")
    await connectGoogle(env, kit, orgId, "nobody", BODY)
    expect(log).toEqual([`restart ${domainRun}`])

    // The slug host's property stays for Google's re-checks.
    expect(await ownProperty(kit, orgId, `https://${slug}/`)).toMatchObject({
      state: "verified",
      token: file,
    })
  })

  it("revokes the old grant when another Google account replaces it, and not for the same account", async () => {
    const orgId = await freshOrg(kit)
    const { env, created } = searchEnv()
    stubGoogle("1//first", "a@example.test")
    await connectGoogle(env, kit, orgId, `user_probe_${orgId}`, BODY)
    // No published site: nothing to verify yet.
    expect(created).toEqual([])
    expect((await connection(orgId))?.connectedByUserId).toBeTruthy()

    const same = stubGoogle("1//second", "a@example.test")
    await connectGoogle(env, kit, orgId, `user_probe_${orgId}`, BODY)
    expect(same).toEqual([])

    const other = stubGoogle("1//third", "b@example.test")
    await connectGoogle(env, kit, orgId, `user_probe_${orgId}`, BODY)
    expect(other).toEqual(["1//second"])
    const row = await connection(orgId)
    expect(row?.googleEmail).toBe("b@example.test")
    expect(await openToken(env, orgId, row?.refreshToken ?? "")).toBe(
      "1//third"
    )
  })

  it("marks the connection needs_reauth once when Google refuses the refresh token", async () => {
    const orgId = await freshOrg(kit)
    const { env } = searchEnv()
    stubGoogle("1//gone", "a@example.test")
    await connectGoogle(env, kit, orgId, `user_probe_${orgId}`, BODY)
    await expect(accessToken(env, kit, orgId)).rejects.toThrow(
      "search.needs_reauth"
    )
    await expect(accessToken(env, kit, orgId)).rejects.toThrow(
      "search.needs_reauth"
    )
    expect((await connection(orgId))?.state).toBe("needs_reauth")
    expect(await typesOf(orgId)).toEqual([
      "search.connected",
      "search.needs_reauth",
    ])
  })
})

describe.skipIf(!url)("the org's own properties", () => {
  it("serves the new file and stops serving one another account was given", async () => {
    const { orgId, slug } = await published()
    const store = storage()
    const env = {
      ROUTES: store.ROUTES,
      SITE_HOST_SUFFIX: SUFFIX,
    } as unknown as Env
    // A host the org does not hold gets no file and no row.
    await expect(
      placeToken(
        env,
        kit,
        { org_id: orgId, host: `p-${orgId}.example.test` },
        "google1a.html"
      )
    ).rejects.toThrow("search.host_not_held")
    expect([...store.pointers.keys()]).toEqual([])
    const params = { org_id: orgId, host: slug }
    await placeToken(env, kit, params, "google1a.html")
    await placeToken(env, kit, params, "google1a.html")
    await placeToken(env, kit, params, "google2b.html")
    expect([...store.pointers.keys()]).toEqual([
      `gsv:${params.host}:google2b.html`,
    ])
    const property = await ownProperty(kit, orgId, `https://${params.host}/`)
    expect([property.token, property.state]).toEqual([
      "google2b.html",
      "pending",
    ])
  })

  it("refuses a site_url another org holds, and finds the org's own", async () => {
    const mine = await freshOrg(kit)
    const theirs = await freshOrg(kit)
    const add = (orgId: string, host: string) =>
      kit.withOrg({ orgId }, (db) =>
        db.insert(searchProperties).values({
          orgId,
          host,
          siteUrl: `https://${host}/`,
          kind: "subdomain",
          method: "file",
        })
      )
    await add(mine, `mine-${mine}.example.test`)
    await add(theirs, `theirs-${theirs}.example.test`)
    await expect(
      ownProperty(kit, mine, `https://theirs-${theirs}.example.test/`)
    ).rejects.toThrow("search.foreign_site")
    await expect(
      ownProperty(kit, mine, "https://example.com/")
    ).rejects.toThrow("search.foreign_site")
    expect(
      (await ownProperty(kit, mine, `https://mine-${mine}.example.test/`)).orgId
    ).toBe(mine)
  })
})
