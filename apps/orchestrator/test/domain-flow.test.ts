import type { Tenancy } from "@workspace/db"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  connect,
  currentCheck,
  look,
  nextWait,
  normalizeName,
  postStatus,
  statusText,
} from "../src/domain-flow.ts"
import { CAA_FOR_US } from "../src/domains.ts"
import { stubNet } from "./fixtures/domains.ts"

/**
 * The connect Workflow's decisions, on the recorded GoDaddy answers: what a
 * look concludes, when the owner is told, and what the name is taken to be.
 * The database is a stand-in that keeps one row and the events written, so a
 * message's key behaves as the events table's unique key does.
 */

const NAME = "sparklecleanbristol.co.uk"
const WWW = `www.${NAME}`
const BASE = "https://api.cloudflare.com/client/v4/zones/zone/custom_hostnames"
const env = {
  CF_DOMAINS_TOKEN: "token",
  CF_DOMAINS_ZONE_ID: "zone",
} as unknown as Env

const hostname = (host: string, status: string, ssl: string) =>
  Response.json({
    success: true,
    errors: [],
    messages: [],
    result: { id: `h-${host}`, hostname: host, status, ssl: { status: ssl } },
  })

/** www now CNAMEs to us, and the apex keeps its old A (forward mode). */
const FIXED = {
  [`${WWW} A`]: {
    Status: 0,
    Answer: [
      { name: WWW, type: 5, TTL: 300, data: "domains.remeai.co.uk." },
      { name: "domains.remeai.co.uk", type: 1, TTL: 300, data: "104.21.0.10" },
    ],
  },
  [`${NAME} CAA`]: { Status: 0 },
}

function fakeKit() {
  const row = {
    id: "dom",
    orgId: "org",
    siteId: "org",
    name: NAME,
    primaryHost: WWW,
    state: "awaiting_dns" as string,
    cfIds: { apex: `h-${NAME}`, www: `h-${WWW}` },
    lastCheck: null as unknown,
    provider: null,
    createdAt: new Date(),
  }
  const events: { type: string; payload: { key: string; text: string } }[] = []
  const keys = new Set<string>()
  const db = {
    select: () => ({ from: () => ({ where: async () => [row] }) }),
    update: () => ({
      set: (values: object) => ({
        where: () => {
          Object.assign(row, values)
          return { returning: async () => [{ id: row.id }] }
        },
      }),
    }),
    insert: () => ({
      values: async (v: {
        idempotencyKey: string
        type: string
        payload: { key: string; text: string }
      }) => {
        if (keys.has(v.idempotencyKey)) {
          throw Object.assign(new Error("duplicate"), { code: "23505" })
        }
        keys.add(v.idempotencyKey)
        events.push(v)
      },
    }),
  }
  const kit = {
    withOrg: async (_: unknown, fn: (db: unknown) => unknown) => fn(db),
  } as unknown as Tenancy
  return { kit, row, events }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("a look", () => {
  it("tells the owner about a planted A record exactly once, then goes ready when it is fixed", async () => {
    const { kit, row, events } = fakeKit()
    const pending = {
      [`${BASE}/h-${NAME}`]: () => hostname(NAME, "pending", "initializing"),
      [`${BASE}/h-${WWW}`]: () => hostname(WWW, "pending", "initializing"),
    }
    stubNet(pending, { [`${NAME} CAA`]: { Status: 0 } })
    expect(await look(env, kit, "org", "dom", 1)).toMatchObject({
      gone: false,
      status: "conflicting_record",
      ready: false,
    })
    expect(await look(env, kit, "org", "dom", 2)).toMatchObject({
      status: "conflicting_record",
    })
    expect(events.map((e) => e.payload.text)).toEqual([
      `Nearly there. ${WWW} still has an old A record (192.0.2.10) in the way. Delete it and I'll pick it up from there.`,
    ])
    expect(row.state).toBe("awaiting_dns")

    vi.unstubAllGlobals()
    stubNet(
      {
        [`${BASE}/h-${NAME}`]: () => hostname(NAME, "pending", "initializing"),
        [`${BASE}/h-${WWW}`]: () => hostname(WWW, "active", "active"),
        // The router's answer for a host it has no pointer for yet.
        [`https://${WWW}/`]: () => new Response("not here", { status: 404 }),
      },
      FIXED
    )
    expect(await look(env, kit, "org", "dom", 3)).toMatchObject({
      status: "valid",
      ready: true,
    })
    expect(row).toMatchObject({
      state: "verifying",
      primaryHost: WWW,
      lastCheck: { status: "valid" },
    })
    expect(events).toHaveLength(1)
  })

  it("holds a valid domain the edge does not answer for as a certificate still deploying", async () => {
    const { kit, row, events } = fakeKit()
    stubNet(
      {
        [`${BASE}/h-${NAME}`]: () => hostname(NAME, "pending", "initializing"),
        [`${BASE}/h-${WWW}`]: () => hostname(WWW, "active", "active"),
        [`https://${WWW}/`]: () => new Response(null, { status: 525 }),
      },
      FIXED
    )
    expect(await look(env, kit, "org", "dom", 1)).toMatchObject({
      status: "pending_certificate",
      ready: false,
    })
    expect(row.state).toBe("verifying")
    expect(events.map((e) => e.payload.key)).toEqual(["dom:look:1"])
  })

  it("is gone for a claim that is no longer connecting", async () => {
    const { kit, row } = fakeKit()
    row.state = "removed"
    expect(await look(env, kit, "org", "dom", 1)).toEqual({ gone: true })
  })
})

describe("the check", () => {
  it("serves on www and calls a failed read unknown_error, not a throw", async () => {
    stubNet({
      [`${BASE}/h-${WWW}`]: () => hostname(WWW, "pending", "initializing"),
      [`${BASE}/h-${NAME}`]: () => hostname(NAME, "pending", "initializing"),
    })
    const row = {
      name: NAME,
      primaryHost: WWW,
      cfIds: { apex: `h-${NAME}`, www: `h-${WWW}` },
    }
    expect(await currentCheck(env, row)).toEqual({
      check: {
        status: "conflicting_record",
        conflicts: [
          { type: "A", name: "www", value: "192.0.2.10" },
          { type: "CAA", name: "@", value: '0 issue "digicert.com"' },
        ],
      },
      primary: WWW,
    })
    vi.unstubAllGlobals()
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline")
    })
    expect(await currentCheck(env, row)).toEqual({
      check: { status: "unknown_error" },
      primary: WWW,
    })
  })
})

describe("what the owner is told", () => {
  it("names the record in the way, or the CAA line to add, and nothing for a quiet status", () => {
    expect(
      statusText(
        {
          status: "conflicting_record",
          conflicts: [{ type: "CNAME", name: "www", value: "old.wixdns.net" }],
        },
        NAME,
        WWW
      )
    ).toContain(`${WWW} still has an old CNAME record (old.wixdns.net)`)
    expect(
      statusText(
        {
          status: "conflicting_record",
          conflicts: [{ type: "CAA", name: "@", value: '0 issue "x.com"' }],
        },
        NAME,
        WWW
      )
    ).toContain(CAA_FOR_US)
    for (const status of [
      "not_found",
      "unknown_error",
      "pending_verification",
      "valid",
    ] as const) {
      expect(statusText({ status }, NAME, WWW)).toBeNull()
    }
  })

  it("says a keyed status once however often it is posted", async () => {
    const { kit, events } = fakeKit()
    await postStatus(kit, "org", "dom:active", "live")
    await postStatus(kit, "org", "dom:active", "live")
    expect(events).toHaveLength(1)
  })
})

describe("the name", () => {
  it.each([
    ["WWW.SparkleClean.co.uk.", "sparkleclean.co.uk"],
    [" sparkleclean.co.uk ", "sparkleclean.co.uk"],
  ])("takes %j as %j", (raw, name) => {
    expect(normalizeName(raw)).toBe(name)
  })

  it.each([
    "remeai.co.uk",
    "sparkle-stg.remeai.co.uk",
    "not a domain",
    "localhost",
    "",
    42,
  ])("refuses %j", (raw) => {
    expect(normalizeName(raw)).toBeNull()
  })
})

describe("a connect request", () => {
  const untouched = {
    withOrg: async () => {
      throw new Error("the database was reached")
    },
  } as unknown as Tenancy

  it.each([
    [{ name: "remeai.co.uk", approval_id: "a" }],
    [{ name: "not a domain", approval_id: "a" }],
    [{ name: NAME }],
    [{ name: NAME, approval_id: " " }],
  ])("refuses %j as domain.invalid before reading anything", async (body) => {
    const fetched = stubNet()
    expect(await connect(env, untouched, "org", body)).toMatchObject({
      refused: true,
      status: 400,
      code: "domain.invalid",
    })
    expect(fetched).not.toHaveBeenCalled()
  })

  it("refuses a subdomain other than www: its zone apex is above it", async () => {
    stubNet()
    expect(
      await connect(env, untouched, "org", {
        name: `shop.${NAME}`,
        approval_id: "a",
      })
    ).toMatchObject({ status: 400, code: "domain.invalid" })
  })

  it("refuses a name with no DNS at all, and says so when DNS cannot be read", async () => {
    stubNet()
    expect(
      await connect(env, untouched, "org", {
        name: "nowhere-at-all.co.uk",
        approval_id: "a",
      })
    ).toMatchObject({ status: 400, code: "domain.invalid" })
    vi.unstubAllGlobals()
    vi.stubGlobal("fetch", async () => new Response(null, { status: 502 }))
    expect(
      await connect(env, untouched, "org", { name: NAME, approval_id: "a" })
    ).toMatchObject({ status: 503, code: "dns.unavailable" })
  })
})

it("backs off 2, 5, 15 and 30 minutes, then hourly", () => {
  expect([1, 2, 3, 4, 5, 9].map(nextWait)).toEqual(
    [2, 5, 15, 30, 60, 60].map((m) => m * 60 * 1000)
  )
})
