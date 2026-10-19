import { readFileSync } from "node:fs"
import { fileURLToPath, URL } from "node:url"
import { ErrorEnvelope } from "@workspace/contracts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import worker from "../src/index.ts"
import { WRITE_WINDOW_SECONDS, WRITES_PER_MINUTE } from "../src/limit.ts"
import { cookieHeader, env, stubJwksFetch } from "./sealed-session.ts"

/**
 * Each signed-in person's writes a minute, through the real route and a
 * real session. The binding is a stand-in that counts what it is asked.
 */

const realFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = stubJwksFetch()
})
afterAll(() => {
  globalThis.fetch = realFetch
})

const SUB = "user_probe_write_limit"

/** A limiter that lets `allowed` calls through and records every key. */
function limiter(allowed: number) {
  const keys: string[] = []
  return {
    keys,
    limit: async ({ key }: { key: string }) => {
      keys.push(key)
      return { success: keys.length <= allowed }
    },
  }
}

const call = async (
  WRITE_LIMIT: ReturnType<typeof limiter>,
  method: string,
  path: string,
  signedIn = true
) =>
  worker.fetch(
    new Request(`http://api.invalid${path}`, {
      method,
      headers: signedIn
        ? await cookieHeader({ sub: SUB, org_id: "org_probe_write_limit" })
        : {},
    }),
    {
      ...env("postgresql://127.0.0.1:1/none"),
      WRITE_LIMIT,
    } as unknown as Env,
    { waitUntil: () => undefined } as unknown as ExecutionContext
  )

describe("the write limit", () => {
  it("answers a write over the minute with 429 rate.limited and Retry-After", async () => {
    const counted = limiter(0)
    const response = await call(counted, "POST", "/chat")
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe(
      String(WRITE_WINDOW_SECONDS)
    )
    const body = ErrorEnvelope.parse(await response.json())
    expect(body.code).toBe("rate.limited")
    expect(body.class).toBe("transient")
    expect(counted.keys).toEqual([`writes:${SUB}`])
  })

  it("lets a write under the minute through to its route", async () => {
    const counted = limiter(1)
    // No idempotency key, so the route's own 400 proves it was reached.
    const response = await call(counted, "POST", "/org")
    expect(response.status).toBe(400)
    expect(counted.keys).toHaveLength(1)
  })

  it("counts DELETE as a write", async () => {
    const counted = limiter(0)
    expect((await call(counted, "DELETE", "/account")).status).toBe(429)
  })

  it("does not count a read", async () => {
    const counted = limiter(0)
    // The database is unreachable, so the read fails on its own terms.
    expect((await call(counted, "GET", "/workspace")).status).not.toBe(429)
    expect(counted.keys).toEqual([])
  })

  it("does not count a write with no session, which is refused anyway", async () => {
    const counted = limiter(0)
    expect((await call(counted, "POST", "/org", false)).status).toBe(401)
    expect(counted.keys).toEqual([])
  })
})

describe("the Worker is configured with the limit", () => {
  type Config = {
    ratelimits?: {
      name: string
      namespace_id: string
      simple: { limit: number; period: number }
    }[]
    env: { production: Config }
  }
  // jsonc with whole-line `//` comments only.
  const config = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
      "utf8"
    ).replace(/^\s*\/\/.*$/gm, "")
  ) as Config
  const binding = (block: Config) =>
    block.ratelimits?.find((entry) => entry.name === "WRITE_LIMIT")
  const staging = binding(config)
  const production = binding(config.env.production)

  it("declares WRITE_LIMIT in both blocks, since bindings do not inherit", () => {
    expect(staging, "staging has no WRITE_LIMIT binding").toBeDefined()
    expect(production, "production has no WRITE_LIMIT binding").toBeDefined()
  })

  it("gives each its own namespace, apart from the web's and the router's", () => {
    // A namespace id is shared by every binding in the account that names it.
    const taken = ["1001", "1002"]
    expect(taken).not.toContain(staging?.namespace_id)
    expect(taken).not.toContain(production?.namespace_id)
    expect(staging?.namespace_id).not.toBe(production?.namespace_id)
  })

  it("configures both with the numbers limit.ts reasons about", () => {
    for (const block of [staging, production]) {
      expect(block?.simple.limit).toBe(WRITES_PER_MINUTE)
      expect(block?.simple.period).toBe(WRITE_WINDOW_SECONDS)
      expect([10, 60]).toContain(block?.simple.period)
    }
  })
})
