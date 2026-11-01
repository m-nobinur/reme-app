import { readFileSync } from "node:fs"
import { fileURLToPath, URL } from "node:url"
import {
  QUOTE_NOT_SENT_PATH,
  QUOTE_PATH,
  QUOTE_SENT_PATH,
  QUOTE_TRAP_FIELD,
  UPLOAD_MAX_BYTES,
} from "@workspace/contracts"
import { deliveries, sql, type Tenancy, tenancy } from "@workspace/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import worker from "../src/index.ts"
import { owner, SUFFIX, seed, stubOrchestrator } from "./owner-fixture.ts"
import { env } from "./sealed-session.ts"

/**
 * `POST /api/quote` through the worker: a website visitor's quote request,
 * filed under the org its host names. Every answer is a 303 back to the
 * site's quote page; the photos are re-encoded before they are kept, and the
 * request goes to the owner's chat through the deliveries outbox.
 */

const url = process.env.DATABASE_URL
const UNREACHABLE = "postgresql://127.0.0.1:1/none"
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
])

/** Bindings that record what the route did with them. */
function bindings(allowed = 5) {
  const limited: string[] = []
  const kept: string[] = []
  const sent: { key: string; message: Record<string, unknown> }[] = []
  return {
    limited,
    kept,
    sent,
    values: {
      QUOTE_LIMIT: {
        limit: async ({ key }: { key: string }) => {
          limited.push(key)
          return { success: limited.length <= allowed }
        },
      },
      IMAGES: {
        input: () => ({
          transform: () => ({
            output: async () => ({ image: () => new Response("webp").body }),
          }),
        }),
      },
      SITES: {
        put: async (key: string) => {
          kept.push(key)
        },
      },
      DELIVERIES: {
        send: async (message: (typeof sent)[number]) => {
          sent.push(message)
        },
      },
    },
  }
}

const quote = (fields: Record<string, string | File>) => {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  return form
}

const visitor = {
  name: "Jane Visitor",
  email: "jane@example.com",
  service_type: "Deep clean",
  bedrooms: "3",
}

/** The form encoded as a browser sends it, its length declared. */
async function encoded(form: FormData) {
  const body = new Response(form)
  const bytes = await body.arrayBuffer()
  return {
    body: bytes,
    headers: {
      "content-type": body.headers.get("content-type") ?? "",
      "content-length": String(bytes.byteLength),
    },
  }
}

async function post(
  host: string,
  form: FormData | RequestInit,
  b: ReturnType<typeof bindings>,
  database = url ?? UNREACHABLE
) {
  const init = form instanceof FormData ? await encoded(form) : form
  return worker.fetch(
    new Request(`https://${host}${QUOTE_PATH}`, {
      method: "POST",
      ...init,
      headers: {
        "cf-connecting-ip": "203.0.113.7",
        ...(init.headers as Record<string, string>),
      },
    }),
    {
      ...env(database),
      ORCHESTRATOR: stubOrchestrator(),
      SITE_HOST_SUFFIX: SUFFIX,
      ...b.values,
    } as unknown as Env,
    { waitUntil: () => undefined } as unknown as ExecutionContext
  )
}

const sentBack = (response: Response) => {
  expect(response.status).toBe(303)
  return (
    new URL(response.headers.get("location") ?? "").pathname +
    new URL(response.headers.get("location") ?? "").hash
  )
}

describe("POST /api/quote, before anything is stored", () => {
  it("sends a visitor over the minute back to try again, keyed by their address", async () => {
    const b = bindings(0)
    const response = await post(
      `probe${SUFFIX}`,
      quote(visitor),
      b,
      UNREACHABLE
    )
    expect(sentBack(response)).toBe(QUOTE_NOT_SENT_PATH)
    expect(b.limited).toEqual(["quote:203.0.113.7"])
  })

  it("refuses a body that declares no length, or more than five photos' worth, unread", async () => {
    const streamed = {
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("name=Jane"))
          controller.close()
        },
      }),
      duplex: "half",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    } as RequestInit
    const oversized = {
      body: "name=Jane",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(6 * UPLOAD_MAX_BYTES),
      },
    }
    for (const init of [streamed, oversized]) {
      const b = bindings()
      const response = await post(`probe${SUFFIX}`, init, b, UNREACHABLE)
      expect(sentBack(response)).toBe(QUOTE_NOT_SENT_PATH)
      expect(b.limited).toEqual([])
    }
  })

  it("thanks a filled honeypot and keeps nothing, without reaching the database", async () => {
    const b = bindings()
    const response = await post(
      `probe${SUFFIX}`,
      quote({ ...visitor, [QUOTE_TRAP_FIELD]: "https://spam.example" }),
      b,
      UNREACHABLE
    )
    expect(sentBack(response)).toBe(QUOTE_SENT_PATH)
    expect(b.kept).toEqual([])
    expect(b.sent).toEqual([])
  })
})

describe("the Worker is configured with the quote limit", () => {
  type Block = {
    ratelimits?: { name: string; namespace_id: string }[]
  }
  const config = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
      "utf8"
    ).replace(/^\s*\/\/.*$/gm, "")
  ) as Block & { env: { production: Block } }
  const ids = (block: Block) =>
    block.ratelimits?.map((entry) => [entry.name, entry.namespace_id]) ?? []

  it("declares QUOTE_LIMIT in both blocks under namespaces of its own", () => {
    const staging = ids(config).find(([name]) => name === "QUOTE_LIMIT")
    const production = ids(config.env.production).find(
      ([name]) => name === "QUOTE_LIMIT"
    )
    expect(staging).toBeDefined()
    expect(production).toBeDefined()
    const all = [...ids(config), ...ids(config.env.production)].map(
      ([, id]) => id
    )
    expect(new Set(all).size).toBe(all.length)
  })
})

describe.skipIf(!url)("POST /api/quote, on a live connection", () => {
  const kit: Tenancy = tenancy(url as string, { max: 3 })
  let published: Awaited<ReturnType<typeof owner>>
  let draft: Awaited<ReturnType<typeof owner>>

  beforeAll(async () => {
    published = await owner(kit, url as string, "quote_live")
    draft = await owner(kit, url as string, "quote_draft")
    const s = seed(kit, published)
    const live = await s.assignment("published")
    const revision = await s.revision(live, 1)
    await s.deployment(revision, await s.approval(live, revision, 1, true))
  })
  afterAll(() => kit.close())

  const stored = (orgId: string) =>
    kit.withOrg({ orgId }, (db) =>
      db
        .select({ key: deliveries.key, channel: deliveries.channel })
        .from(deliveries)
        .where(sql`${deliveries.key} like 'enquiry:%'`)
    )

  it("files a request with its photos under the org the host names, and thanks the visitor", async () => {
    const b = bindings()
    const response = await post(
      `${published.slug}${SUFFIX}`,
      quote({
        ...visitor,
        phone: "01632 960000",
        property_photos: new File([PNG], "kitchen.png"),
        // Named like a picture, but not one: never kept.
        property_photos_2: new File(["<svg/>"], "trick.png"),
        property_photos_3: new File(
          [new Uint8Array(UPLOAD_MAX_BYTES + 1)],
          "huge.png"
        ),
      }),
      b
    )
    expect(sentBack(response)).toBe(QUOTE_SENT_PATH)
    expect(b.kept).toHaveLength(1)
    expect(b.kept[0]).toMatch(
      new RegExp(`^enquiries/${published.orgId}/[0-9a-f-]{36}$`)
    )
    expect(b.sent).toHaveLength(1)
    const [delivery] = b.sent
    const message = delivery?.message as {
      text: string[]
      enquiry: {
        name: string
        email: string
        phone: string
        answers: { label: string; value: string }[]
        photos: string[]
      }
    }
    expect(message.text[0]).not.toContain("Jane")
    expect(message.text[1]).toContain("2 of their photos")
    expect(message.enquiry).toMatchObject({
      name: "Jane Visitor",
      email: "jane@example.com",
      phone: "01632 960000",
      answers: [
        { label: "Service type", value: "Deep clean" },
        { label: "Bedrooms", value: "3" },
      ],
    })
    expect(message.enquiry.photos).toEqual([b.kept[0]?.split("/").pop()])
    expect(await stored(published.orgId)).toEqual([
      { key: delivery?.key, channel: "in_app" },
    ])
  })

  it("keeps at most five photos", async () => {
    const b = bindings()
    const photos = Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => [
        `photo_${i}`,
        new File([PNG], `p${i}.png`),
      ])
    )
    await post(
      `${published.slug}${SUFFIX}`,
      quote({ ...visitor, ...photos }),
      b
    )
    expect(b.kept).toHaveLength(5)
  })

  it("sends a request it cannot read back to the form, and keeps nothing", async () => {
    const b = bindings()
    const response = await post(
      `${published.slug}${SUFFIX}`,
      quote({ ...visitor, email: "not an address" }),
      b
    )
    expect(sentBack(response)).toBe(QUOTE_NOT_SENT_PATH)
    expect(b.kept).toEqual([])
    expect(b.sent).toEqual([])
  })

  it("takes nothing for a site never published, or for a host that is no site", async () => {
    for (const host of [`${draft.slug}${SUFFIX}`, "api.invalid"]) {
      const b = bindings()
      const response = await post(host, quote(visitor), b)
      expect(response.status).toBe(404)
      expect(b.kept).toEqual([])
      expect(b.sent).toEqual([])
    }
    expect(await stored(draft.orgId)).toEqual([])
  })
})
