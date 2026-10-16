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

/** What the chat's post answers, in order, and every post asked of it. */
const posting = vi.hoisted(() => ({
  answers: [] as string[],
  calls: [] as unknown[],
}))
vi.mock("@workspace/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/db")>()),
  postAssistantMessage: async (_kit: unknown, post: unknown) => {
    posting.calls.push(post)
    return posting.answers.shift() ?? "posted"
  },
}))

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
    needsTxt: false,
    ownership: {} as unknown,
    lastCheck: null as unknown,
    provider: {
      name: "GoDaddy",
      settings_url: "https://dcc.godaddy.com/manage/dns",
    } as unknown,
    createdAt: new Date(),
  }
  const events: { type: string; payload: { key: string; text: string } }[] = []
  const keys = new Set<string>()
  const writes = { n: 0 }
  const db = {
    select: () => ({ from: () => ({ where: async () => [row] }) }),
    update: () => ({
      set: (values: object) => ({
        where: () => {
          writes.n++
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
  return { kit, row, events, writes }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("a look", () => {
  it("tells the owner about a planted A record exactly once, then goes ready when it is fixed", async () => {
    const { kit, row, writes } = fakeKit()
    const pending = {
      [`${BASE}/h-${NAME}`]: () => hostname(NAME, "pending", "initializing"),
      [`${BASE}/h-${WWW}`]: () => hostname(WWW, "pending", "initializing"),
    }
    stubNet(pending, { [`${NAME} CAA`]: { Status: 0 } })
    expect(await look(env, kit, "org", "dom", 1)).toEqual({
      gone: false,
      at: expect.any(Number),
      status: "conflicting_record",
      ready: false,
      say: {
        key: "dom:look:1",
        text: `Nearly there. ${WWW} still has an old A record (192.0.2.10) in the way. Delete it and I'll pick it up from there.`,
        button: {
          label: "Open GoDaddy DNS settings",
          action: { kind: "open", url: "https://dcc.godaddy.com/manage/dns" },
        },
      },
    })
    // The same record still there: nothing new to say.
    const again = await look(env, kit, "org", "dom", 2)
    expect(again).toMatchObject({ status: "conflicting_record" })
    expect(again).not.toHaveProperty("say")
    expect(row.state).toBe("awaiting_dns")
    // A look that finds what the last one did writes nothing.
    expect(writes.n).toBe(1)

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
    const ready = await look(env, kit, "org", "dom", 3)
    expect(ready).toMatchObject({ status: "valid", ready: true })
    // Live has its own message, from the activation.
    expect(ready).not.toHaveProperty("say")
    expect(row).toMatchObject({
      state: "verifying",
      primaryHost: WWW,
      lastCheck: { status: "valid" },
    })
  })

  it("holds a valid domain the edge does not answer for as a certificate still deploying", async () => {
    const { kit, row } = fakeKit()
    stubNet(
      {
        [`${BASE}/h-${NAME}`]: () => hostname(NAME, "pending", "initializing"),
        [`${BASE}/h-${WWW}`]: () => hostname(WWW, "active", "active"),
        [`https://${WWW}/`]: () => new Response(null, { status: 525 }),
      },
      FIXED
    )
    const seen = await look(env, kit, "org", "dom", 1)
    expect(seen).toMatchObject({
      status: "pending_certificate",
      ready: false,
      say: { key: "dom:look:1" },
    })
    // Nothing for the owner to do here, so no button.
    expect(seen.gone || seen.say?.button).toBeUndefined()
    expect(row.state).toBe("verifying")
  })

  it("keeps a guarded claim unverified until its ownership TXT is in public DNS", async () => {
    const { kit, row } = fakeKit()
    row.needsTxt = true
    const own = { name: `_cf-custom-hostname.${WWW}`, value: "0e2d5a7f-uuid" }
    row.ownership = { [WWW]: own }
    const net = {
      [`${BASE}/h-${NAME}`]: () => hostname(NAME, "pending", "initializing"),
      // Cloudflare calls it active on the CNAME alone.
      [`${BASE}/h-${WWW}`]: () => hostname(WWW, "active", "active"),
      [`https://${WWW}/`]: () => new Response("not here", { status: 404 }),
    }
    stubNet(net, FIXED)
    expect(await look(env, kit, "org", "dom", 1)).toMatchObject({
      status: "pending_verification",
      ready: false,
    })
    // A TXT with another value is not the owner's proof either.
    const txt = (value: string) => ({
      [`${own.name} TXT`]: {
        Status: 0,
        Answer: [{ name: own.name, type: 16, TTL: 300, data: `"${value}"` }],
      },
    })
    vi.unstubAllGlobals()
    stubNet(net, { ...FIXED, ...txt("someone-else") })
    expect(await look(env, kit, "org", "dom", 2)).toMatchObject({
      status: "pending_verification",
      ready: false,
    })
    vi.unstubAllGlobals()
    stubNet(net, { ...FIXED, ...txt(own.value) })
    expect(await look(env, kit, "org", "dom", 3)).toMatchObject({
      status: "valid",
      ready: true,
    })
    // A host with no stored TXT is never taken as proven.
    row.ownership = {}
    expect(await look(env, kit, "org", "dom", 4)).toMatchObject({
      status: "pending_verification",
    })
  })

  it("is gone for a claim that is no longer connecting", async () => {
    const { kit, row } = fakeKit()
    row.state = "removed"
    expect(await look(env, kit, "org", "dom", 1)).toEqual({ gone: true })
  })
})

describe("the check", () => {
  it("reads neither DNS nor Cloudflare before the hostnames exist", async () => {
    const fetched = stubNet()
    const row = {
      name: NAME,
      cfIds: {},
      primaryHost: WWW,
      needsTxt: false,
      ownership: {},
    }
    expect(await currentCheck(env, row)).toEqual({
      check: { status: "not_found" },
      primary: WWW,
    })
    expect(fetched).not.toHaveBeenCalled()
  })

  it("serves on www and calls a failed read unknown_error, not a throw", async () => {
    stubNet({
      [`${BASE}/h-${WWW}`]: () => hostname(WWW, "pending", "initializing"),
      [`${BASE}/h-${NAME}`]: () => hostname(NAME, "pending", "initializing"),
    })
    const row = {
      name: NAME,
      primaryHost: WWW,
      cfIds: { apex: `h-${NAME}`, www: `h-${WWW}` },
      needsTxt: false,
      ownership: {},
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

  it("keeps one audit row per key and posts to the chat under the same key", async () => {
    const { kit, events } = fakeKit()
    const say = { key: "dom:active", text: "live" }
    posting.answers.push("posted", "exists")
    await postStatus(kit, "org", say)
    await postStatus(kit, "org", say)
    expect(events.map((e) => e.type)).toEqual(["domain.status"])
    expect(posting.calls).toEqual([
      {
        orgId: "org",
        key: "domain.status:dom:active",
        message: { text: ["live"] },
      },
      {
        orgId: "org",
        key: "domain.status:dom:active",
        message: { text: ["live"] },
      },
    ])
  })

  it.each(["busy", "waiting"] as const)(
    "throws on a %s chat, so the step retries the post",
    async (answer) => {
      const { kit } = fakeKit()
      posting.answers.push(answer)
      await expect(
        postStatus(kit, "org", { key: "k", text: "t" })
      ).rejects.toThrow(`status.${answer}`)
    }
  )

  it("logs and lets go of an org with no conversation", async () => {
    const { kit } = fakeKit()
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    posting.answers.push("none")
    await postStatus(kit, "org", { key: "k", text: "t" })
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ code: "domain.status_unposted", key: "k" })
    )
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

  it("refuses a subdomain more than one level below its zone apex", async () => {
    stubNet(
      {},
      {
        [`a.shop.${NAME} SOA`]: {
          Status: 0,
          Authority: [
            { name: NAME, type: 6, TTL: 600, data: "ns. h. 1 1 1 1 1" },
          ],
        },
      }
    )
    expect(
      await connect(env, untouched, "org", {
        name: `a.shop.${NAME}`,
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

it("looks every minute for the first half hour, every 10 to two hours, then hourly", () => {
  const MIN = 60 * 1000
  expect([0, 29, 30, 119, 120, 71 * 60].map((m) => nextWait(m * MIN))).toEqual(
    [1, 1, 10, 10, 60, 60].map((m) => m * MIN)
  )
})
