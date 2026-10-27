import { domains, type Tenancy, tenancy } from "@workspace/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import worker from "../src/index.ts"
import { owner, stubOrchestrator } from "./owner-fixture.ts"
import { env, stubJwksFetch } from "./sealed-session.ts"

/**
 * `POST /webhooks/cloudflare` through the worker: only Cloudflare's secret
 * gets in, a hostname this environment does not hold is a quiet 200, and a
 * claim that is still connecting gets the orchestrator's check.
 */

const AUTH = "cf-fixture-for-webhook-tests"
const url = process.env.DATABASE_URL
const alert = (hostname: string) => ({
  metadata: {
    event: { type: "ssl.custom_hostname_certificate.deployment.succeeded" },
  },
  data: { id: "ch_1", hostname, ssl: { status: "active" } },
})

function deliver(
  body: object,
  { secret = AUTH, orchestrator = stubOrchestrator() } = {}
) {
  const pending: Promise<unknown>[] = []
  const response = worker.fetch(
    new Request("http://api.invalid/webhooks/cloudflare", {
      method: "POST",
      headers: secret ? { "cf-webhook-auth": secret } : {},
      body: JSON.stringify(body),
    }),
    {
      ...env(url ?? "postgres://unused@127.0.0.1:1/unused"),
      ORCHESTRATOR: orchestrator,
      CF_WEBHOOK_SECRET: AUTH,
    } as unknown as Env,
    {
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    } as unknown as ExecutionContext
  )
  return { response, settled: () => Promise.all(pending) }
}

describe("POST /webhooks/cloudflare secret", () => {
  it("refuses a missing or wrong secret before reading anything", async () => {
    for (const secret of ["", "wrong"]) {
      const stub = stubOrchestrator()
      const { response } = deliver(alert("x.example.com"), {
        secret,
        orchestrator: stub,
      })
      expect((await response).status).toBe(401)
      expect(stub.calls).toHaveLength(0)
    }
  })
})

describe.skipIf(!url)("POST /webhooks/cloudflare, on a live connection", () => {
  const kit: Tenancy = tenancy(url as string, { max: 3 })
  let realFetch: typeof fetch
  let orgId: string

  beforeAll(async () => {
    realFetch = globalThis.fetch
    globalThis.fetch = stubJwksFetch()
    orgId = (await owner(kit, url as string, "cert-webhook")).orgId
  }, 60_000)

  afterAll(async () => {
    globalThis.fetch = realFetch
    await kit.close()
  })

  it("answers 200 and calls nobody for a hostname it does not hold", async () => {
    const stub = stubOrchestrator()
    const { response, settled } = deliver(alert("nobody-holds.example.com"), {
      orchestrator: stub,
    })
    expect((await response).status).toBe(200)
    await settled()
    expect(stub.calls).toHaveLength(0)
  })

  it("asks for the check of a connecting claim under its org, by the apex or its www", async () => {
    const name = `cert-${crypto.randomUUID().slice(0, 8)}.example.com`
    await kit.withOrg({ orgId }, (db) =>
      db.insert(domains).values({
        orgId,
        siteId: crypto.randomUUID(),
        name,
        primaryHost: `www.${name}`,
        origin: "connected",
        method: "records",
        state: "awaiting_dns",
      })
    )
    const stub = stubOrchestrator(() => Response.json({}))
    const { response, settled } = deliver(alert(`WWW.${name}`), {
      orchestrator: stub,
    })
    expect((await response).status).toBe(200)
    await settled()
    const [call] = stub.calls
    expect(call?.request.url).toBe(
      `https://orchestrator/assignments/domains/${name}/check`
    )
    expect(call?.request.headers.get("x-reme-org-id")).toBe(orgId)
  })
})
