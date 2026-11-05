import { ADDRESS_ASK } from "@workspace/contracts"
import {
  conversationMessages,
  conversations,
  domains,
  eq,
  events,
  openTask,
  ownerTasks,
  putOff,
  readTasks,
  serverMessageId,
  setStep,
  sql,
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
import { offerAddress, sayLive } from "../src/publish.ts"
import { announce, searchInstanceId } from "../src/search.ts"
import { freshOrg, kit as pool } from "./fixture.ts"
import { stubNet } from "./fixtures/domains.ts"

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

  it("say the site is live, and ask about an address the build's offer never asked", async () => {
    expect(
      await posted(
        (orgId) =>
          sayLive({}, pool, orgId, "site-1", "https://sparkle.example.test/"),
        () => "site.live:site-1"
      )
    ).toEqual([
      "Congratulations, your website is live. Customers can now find you online and ask for a quote at any time. Whenever you're ready for an address of your own, it takes a couple of minutes and customers trust it more than the free one.",
    ])
  })

  /** The parts and the address task of a fresh org after `sayLive`, with `email` as its business email. */
  async function liveFor(email?: string, picking = false) {
    const orgId = await freshOrg(pool)
    if (picking) {
      await pool.withOrg({ orgId }, async (db) => {
        const task = await openTask(db, orgId, "address")
        await setStep(db, task, "find_out", { state: "done" })
        await setStep(db, task, "choose", {
          state: "blocked",
          blocked_on: "owner_action",
          note: "picking a name",
        })
      })
    }
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

  it("asks nothing when the owner is already past finding out", async () => {
    const { parts, task } = await liveFor("jo@gmail.com", true)
    expect(parts.some((p) => p.type === "data-build_questions")).toBe(false)
    expect(task?.steps.find((s) => s.step === "find_out")?.state).toBe("done")
    expect(task?.steps.find((s) => s.step === "choose")).toMatchObject({
      state: "blocked",
      note: "picking a name",
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
      text: "Congratulations, your website is live. Your email runs on sparkleclean.co.uk, so you already own the right address for it: customers who've emailed you will recognise it, and Google will tie your website to the name you've used all along. Shall I put it there?",
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

  /** A fresh org with a chat, `setup` run in it, then `say`, and what landed under `key`. */
  async function spoken(
    setup: (
      db: Parameters<Parameters<Tenancy["withOrg"]>[1]>[0],
      orgId: string
    ) => Promise<unknown>,
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
      await setup(db, orgId)
    })
    await say(orgId)
    const [row] = await pool.withOrg({ orgId }, (db) =>
      db
        .select({ content: conversationMessages.content })
        .from(conversationMessages)
        .where(eq(conversationMessages.id, serverMessageId(key(orgId))))
    )
    const parts =
      (
        row?.content as
          | { parts: { type: string; text?: string; data?: unknown }[] }
          | undefined
      )?.parts ?? []
    return {
      orgId,
      text: parts.find((p) => p.type === "text")?.text,
      button: parts.find((p) => p.type === "data-button")?.data,
      asks: parts.some((p) => p.type === "data-build_questions"),
    }
  }

  /** A name no other run of this suite holds, since live names are unique. */
  let name = ""
  const fresh = () => {
    name = `d${crypto.randomUUID().slice(0, 8)}.co.uk`
  }

  const claim = (
    db: Parameters<Parameters<Tenancy["withOrg"]>[1]>[0],
    orgId: string,
    state: "awaiting_dns" | "verifying" | "failed",
    lastCheck: unknown = null
  ) =>
    db.insert(domains).values({
      orgId,
      siteId: orgId,
      name,
      primaryHost: name,
      origin: "connected",
      method: "records",
      state,
      lastCheck,
    })

  const live = (orgId: string) =>
    sayLive({}, pool, orgId, "site-1", "https://sparkle.example.test/")

  it("offers the address once while the first build runs, with the card, and opens the task", async () => {
    const offered = await spoken(
      async () => undefined,
      (orgId) => offerAddress({}, pool, orgId),
      (orgId) => `address.offer:${orgId}`
    )
    expect(offered.text).toMatch(
      /^While it builds, let's sort out its address\./
    )
    expect(offered.asks).toBe(true)
    const tasks = await pool.withOrg({ orgId: offered.orgId }, readTasks)
    expect(
      tasks
        .find((t) => t.kind === "address")
        ?.steps.find((s) => s.step === "find_out")
    ).toMatchObject({ state: "blocked" })
    // An address task already there: nothing more is offered.
    await offerAddress({}, pool, offered.orgId)
    const posts = await pool.withOrg({ orgId: offered.orgId }, (db) =>
      db.select({ id: conversationMessages.id }).from(conversationMessages)
    )
    expect(posts).toHaveLength(1)
  })

  it("brings the setting back at publish while it is still due, with a button to show it", async () => {
    fresh()
    const said = await spoken(
      (db, orgId) => claim(db, orgId, "awaiting_dns"),
      live,
      () => "site.live:site-1"
    )
    expect(said.text).toContain(
      `Now's the moment to add the setting for ${name}`
    )
    expect(said.button).toEqual({
      label: "Show the setting",
      action: { kind: "ask", text: `Show me the setting for ${name}` },
    })
  })

  it("says the padlock is on its way at publish when the setting is in", async () => {
    fresh()
    const said = await spoken(
      (db, orgId) =>
        claim(db, orgId, "verifying", { status: "pending_certificate" }),
      live,
      () => "site.live:site-1"
    )
    expect(said.text).toContain(`while ${name} gets its security padlock`)
    expect(said.button).toMatchObject({ label: "Visit your website" })
  })

  it("brings a lapsed claim's setting back at publish, with a button to connect it again", async () => {
    fresh()
    const said = await spoken(
      async (db, orgId) => {
        await openTask(db, orgId, "address", { name })
        await claim(db, orgId, "failed")
      },
      live,
      () => "site.live:site-1"
    )
    expect(said.text).toContain(`${name} wasn't connected in time`)
    expect(said.button).toEqual({
      label: `Connect ${name}`,
      action: { kind: "ask", text: `Put the site on ${name}` },
    })
  })

  it("offers Google at publish to an owner who said no to an address of their own", async () => {
    const said = await spoken(
      async (db, orgId) => {
        const task = await openTask(db, orgId, "address")
        await db
          .update(ownerTasks)
          .set({ state: "declined" })
          .where(eq(ownerTasks.id, task))
      },
      live,
      () => "site.live:site-1"
    )
    expect(said.text).toContain("connect your Google account")
    expect(said.button).toEqual({
      label: "Connect Google",
      action: { kind: "connect", service: "google" },
    })
  })

  it("asks once more at publish about an address put off during the build", async () => {
    const said = await spoken(
      async (db, orgId) => {
        const task = await openTask(db, orgId, "address")
        await putOff(db, task, 7)
      },
      live,
      () => "site.live:site-1"
    )
    expect(said.text).toContain(
      "Whenever you're ready for an address of your own"
    )
    expect(said.asks).toBe(true)
  })

  it("leaves the live message to a domain ready and waiting, and marks the launch", async () => {
    fresh()
    const said = await spoken(
      (db, orgId) => claim(db, orgId, "verifying", { status: "valid" }),
      live,
      () => "site.live:site-1"
    )
    expect(said.text).toBeUndefined()
    const marked = await pool.withOrg({ orgId: said.orgId }, (db) =>
      db
        .select({ id: events.eventId })
        .from(events)
        .where(sql`${events.type} = 'site.launch_deferred'`)
    )
    expect(marked).toHaveLength(1)
  })

  it("announce Search Console as they did", async () => {
    const host = "sparkle.example.test"
    expect(
      await posted(
        (orgId) => announce({}, pool, { org_id: orgId, host }),
        (orgId) => searchInstanceId(orgId, host)
      )
    ).toEqual([
      `Google now knows about ${host}, and I've sent it every page on your website. New websites usually take a few days to a few weeks to start showing in search, and I'll tell you how it's doing as people find you.`,
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

/** A kit with nothing spent today, whose spend rows are counted, not written. */
function kitFor() {
  const logged = vi.fn()
  const kit = {
    withOrg: async (_ctx: unknown, fn: (db: unknown) => unknown) =>
      fn({
        execute: async () => [{ spent: 0 }],
        insert: () => ({ values: logged }),
      }),
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

  it("tells the writer how the chat's markdown is used", async () => {
    const { kit } = kitFor()
    const write = writer(UPDATE.template)
    await writeUpdate(env, kit, "org", UPDATE, write)
    expect(write.mock.calls[0]?.[1]).toMatch(
      /bold for the one key fact, inline code for a DNS value or record name, a numbered list for steps[^\n]*No links: a button under the message opens whatever the owner needs[^\n]*No headings, no tables/
    )
  })

  it("keeps a bold, code and linked value as the fact verbatim", async () => {
    const { kit } = kitFor()
    const text =
      "I've stopped watching **www.brightclean.co.uk**: its records didn't show up within 3 days."
    expect(await writeUpdate(env, kit, "org", UPDATE, writer(text))).toBe(text)
  })

  it("asks for the facts and the draft, with a short timeout", async () => {
    const { kit } = kitFor()
    const write = writer(UPDATE.template)
    await writeUpdate(env, kit, "org", UPDATE, write)
    expect(write).toHaveBeenCalledWith(
      "test-key",
      expect.stringMatching(
        /Use every value in the facts exactly as written, with no quotation marks/
      ),
      { facts: UPDATE.facts, draft: UPDATE.template },
      15_000
    )
  })

  it("hands the model the moment's brief and returns what it wrote", async () => {
    const { kit } = kitFor()
    const brief = "Say why it matters to the business."
    const write = writer(
      "www.brightclean.co.uk took 3 days. I've let it go for now."
    )
    expect(
      await writeUpdate(env, kit, "org", { ...UPDATE, brief }, write)
    ).toBe("www.brightclean.co.uk took 3 days. I've let it go for now.")
    expect(write).toHaveBeenCalledWith(
      "test-key",
      expect.stringMatching(/never point at the screen/),
      { facts: UPDATE.facts, draft: UPDATE.template, brief },
      15_000
    )
  })
})

describe("faithful", () => {
  it("reads what the owner sees: a value only in a link's target is missing", () => {
    const facts = { host: "sparkle.co.uk" }
    expect(
      faithful(
        "[Removing this link is not allowed](https://sparkle.co.uk) is on Google.",
        facts
      )
    ).toBe(false)
    expect(faithful("**sparkle.co.uk** is on Google.", facts)).toBe(true)
  })

  it("refuses a message cut off mid-sentence", () => {
    const facts = { host: "sparkle.co.uk" }
    expect(faithful("sparkle.co.uk is live. Customers near", facts)).toBe(false)
    expect(faithful("sparkle.co.uk is live.", facts)).toBe(true)
  })

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

  it("refuses a value set in quotation marks, as the template never does", () => {
    const facts = { host: "sparkle.co.uk", google: "Google Search Console" }
    expect(
      faithful(
        "“sparkle.co.uk” is live, and I'm adding it to your “Google Search Console”.",
        facts
      )
    ).toBe(false)
    expect(
      faithful(
        "sparkle.co.uk is live, and I'm adding it to your Google Search Console.",
        facts
      )
    ).toBe(true)
  })
})
