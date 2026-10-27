import { ADDRESS_ASK } from "@workspace/contracts"
import {
  conversationMessages,
  conversations,
  eq,
  readTasks,
  serverMessageId,
  staff,
  supersedeFact,
  type Tenancy,
} from "@workspace/db"
import { afterAll, describe, expect, it, vi } from "vitest"
import {
  faithful,
  type Spent,
  type Update,
  type writeText,
  writeUpdate,
} from "../src/heartbeat-write.ts"
import { sayLive } from "../src/publish.ts"
import { announce, searchInstanceId } from "../src/search.ts"
import { freshOrg, kit as pool } from "./fixture.ts"
import { stubNet } from "./fixtures/domains.ts"

vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  ContainerProxy: class {},
}))
vi.mock("../src/sandbox.ts", () => ({}))
vi.mock("../src/agents/developer.ts", () => ({ Developer: {} }))

describe.skipIf(!process.env.DATABASE_URL)("today's templates", () => {
  afterAll(() => pool.close())

  /** The text posted under `key` in a fresh org's chat, with no model key set. */
  async function posted(
    say: (orgId: string) => Promise<void>,
    key: (orgId: string) => string
  ) {
    const orgId = await freshOrg(pool)
    await pool.withOrg({ orgId }, async (db) => {
      const [chief] = await db
        .select({ id: staff.id })
        .from(staff)
        .where(eq(staff.staffCode, "COS-001"))
      await db.insert(conversations).values({
        orgId,
        kind: "assistant",
        createdByStaffId: chief?.id as string,
      })
    })
    await say(orgId)
    const [row] = await pool.withOrg({ orgId }, (db) =>
      db
        .select({ content: conversationMessages.content })
        .from(conversationMessages)
        .where(eq(conversationMessages.id, serverMessageId(key(orgId))))
    )
    const content = row?.content as
      | { parts: { type: string; text?: string }[] }
      | undefined
    return (content?.parts ?? [])
      .filter((p) => p.type === "text")
      .map((p) => p.text)
  }

  it("say the site is live as they did", async () => {
    expect(
      await posted(
        (orgId) =>
          sayLive({}, pool, orgId, "site-1", "https://sparkle.example.test/"),
        () => "site.live:site-1"
      )
    ).toEqual(["Your website is live at sparkle.example.test."])
  })

  /** The parts and the address task of a fresh org after `sayLive`, with `email` as its business email. */
  async function liveFor(email?: string) {
    const orgId = await freshOrg(pool)
    await pool.withOrg({ orgId }, async (db) => {
      const [chief] = await db
        .select({ id: staff.id })
        .from(staff)
        .where(eq(staff.staffCode, "COS-001"))
      await db.insert(conversations).values({
        orgId,
        kind: "assistant",
        createdByStaffId: chief?.id as string,
      })
      if (email) {
        await supersedeFact(db, {
          orgId,
          key: "business.email",
          factType: "business",
          value: { address: email },
          provenance: { source: "owner_stated", confidence: 1 },
        })
      }
    })
    await sayLive({}, pool, orgId, "site-1", "https://sparkle.example.test/")
    const [row] = await pool.withOrg({ orgId }, (db) =>
      db
        .select({ content: conversationMessages.content })
        .from(conversationMessages)
        .where(eq(conversationMessages.id, serverMessageId("site.live:site-1")))
    )
    const content = row?.content as
      | { parts: { type: string; data?: unknown }[] }
      | undefined
    const parts = content?.parts ?? []
    const task = (await pool.withOrg({ orgId }, (db) => readTasks(db)))[0]
    return { parts, task }
  }

  it("asks in the tray whether they have an address when their email is free mail", async () => {
    const { parts, task } = await liveFor("jo@gmail.com")
    const asked = parts.find((p) => p.type === "data-build_questions")
    expect(asked?.data).toMatchObject({
      kind: "address",
      questions: [
        { text: ADDRESS_ASK.have, input: { kind: "choice" } },
        { text: ADDRESS_ASK.name, skippable: true },
      ],
    })
    expect(task?.steps.find((s) => s.step === "find_out")).toMatchObject({
      state: "blocked",
      blocked_on: "owner_action",
    })
  })

  it("names their own domain and where it lives, with a Connect button", async () => {
    vi.stubGlobal("caches", {
      default: { match: async () => undefined, put: async () => undefined },
    })
    stubNet({
      "https://data.iana.org/rdap/dns.json": () =>
        Response.json({
          services: [[["uk"], ["https://rdap.nominet.uk/uk/"]]],
        }),
      "https://rdap.nominet.uk/uk/domain/sparkleclean.co.uk": () =>
        Response.json({
          entities: [
            {
              roles: ["registrar"],
              vcardArray: ["vcard", [["fn", {}, "text", "123-Reg Limited"]]],
            },
          ],
        }),
    })
    const { parts, task } = await liveFor("hello@sparkleclean.co.uk")
    expect(parts.find((p) => p.type === "text")).toMatchObject({
      text: "Your website is live at sparkle.example.test. Your email is on sparkleclean.co.uk, so I'll put the site there. It's with 123-Reg.",
    })
    expect(parts.find((p) => p.type === "data-button")?.data).toEqual({
      label: "Connect sparkleclean.co.uk",
      action: { kind: "ask", text: "Put the site on sparkleclean.co.uk" },
    })
    expect(parts.some((p) => p.type === "data-build_questions")).toBe(false)
    expect(task).toMatchObject({
      detail: {
        name: "sparkleclean.co.uk",
        origin: "owned",
        registrar: "123-Reg",
      },
    })
    expect(task?.steps.find((s) => s.step === "find_out")?.state).toBe("done")
    vi.unstubAllGlobals()
  })

  it("announce Search Console as they did", async () => {
    const host = "sparkle.example.test"
    expect(
      await posted(
        (orgId) => announce({}, pool, { org_id: orgId, host }),
        (orgId) => searchInstanceId(orgId, host)
      )
    ).toEqual([
      `${host} is now in your Google Search Console. I've sent Google your page list. New sites take days to a few weeks to show up.`,
    ])
  })
})

const SPENT: Spent = {
  model: "stand-in",
  cost_usd: 0.002,
  usage: { input_tokens: 300, output_tokens: 40 },
  ms: 5,
}
const UPDATE: Update = {
  facts: { host: "www.brightclean.co.uk", days: "3" },
  template:
    "I didn't see the records for www.brightclean.co.uk within 3 days, so I've stopped watching.",
}

/** A kit whose spend row is counted, not written. */
function kitFor() {
  const logged = vi.fn()
  const kit = {
    withOrg: async (_ctx: unknown, fn: (db: unknown) => unknown) =>
      fn({ insert: () => ({ values: logged }) }),
  } as unknown as Tenancy
  return { kit, logged }
}

const writer = (text: string | Error) =>
  vi.fn<typeof writeText>(async () => {
    if (text instanceof Error) throw text
    return { text, spent: SPENT }
  })

const env = { OPENROUTER_API_KEY: "test-key" }

describe("a model-written update", () => {
  it("keeps the model's words when every value is quoted and nothing is added", async () => {
    const { kit, logged } = kitFor()
    const text =
      "I've stopped watching www.brightclean.co.uk: its records didn't show up within 3 days. Say the word and I'll try again."
    expect(await writeUpdate(env, kit, "org", UPDATE, writer(text))).toBe(text)
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "cos.background_step",
        payload: expect.objectContaining({
          job: "update",
          outcome: "written",
          cost_usd: 0.002,
        }),
      })
    )
  })

  it("falls back to the template on a fabricated number", async () => {
    const { kit, logged } = kitFor()
    const text =
      "I've stopped watching www.brightclean.co.uk after 72 hours without its records."
    expect(await writeUpdate(env, kit, "org", UPDATE, writer(text))).toBe(
      UPDATE.template
    )
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ outcome: "template" }),
      })
    )
  })

  it("falls back on a model error, a missing value, a quiet reply or no key", async () => {
    const { kit } = kitFor()
    for (const reply of [
      new Error("upstream 502"),
      "I've stopped watching your domain after 3 days.",
      "[quiet] nothing to say",
      "",
    ])
      expect(await writeUpdate(env, kit, "org", UPDATE, writer(reply))).toBe(
        UPDATE.template
      )
    const never = writer("unused")
    expect(await writeUpdate({}, kit, "org", UPDATE, never)).toBe(
      UPDATE.template
    )
    expect(never).not.toHaveBeenCalled()
  })

  it("asks for the facts and the draft, with a short timeout", async () => {
    const { kit } = kitFor()
    const write = writer(UPDATE.template)
    await writeUpdate(env, kit, "org", UPDATE, write)
    expect(write).toHaveBeenCalledWith(
      "test-key",
      expect.stringMatching(/Quote every value in the facts exactly/),
      { facts: UPDATE.facts, draft: UPDATE.template },
      15_000
    )
  })
})

describe("faithful", () => {
  it("wants every value verbatim and no other number or link", () => {
    const facts = { host: "sparkle.co.uk", slug: "sparkle-stg.remeai.co.uk" }
    expect(
      faithful(
        "sparkle.co.uk is live, and sparkle-stg.remeai.co.uk forwards to it.",
        facts
      )
    ).toBe(true)
    expect(faithful("sparkle.co.uk is live.", facts)).toBe(false)
    expect(
      faithful(
        "sparkle.co.uk is live, and sparkle-stg.remeai.co.uk forwards to it in 2 minutes.",
        facts
      )
    ).toBe(false)
    expect(
      faithful(
        "sparkle.co.uk is live; sparkle-stg.remeai.co.uk forwards to it. See cheap.biz too.",
        facts
      )
    ).toBe(false)
  })
})
