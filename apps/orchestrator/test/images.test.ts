import { describe, expect, it, vi } from "vitest"
import { applyPhotos } from "../src/photo-step.ts"

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {},
}))
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class NonRetryableError extends Error {},
}))

const {
  directPhotos,
  MAX_PER_BUILD,
  MAX_PER_DAY,
  NEVER,
  PHOTO_MODEL,
  placeGenerated,
} = await import("../src/images.ts")

const ORG = "10000001-0000-4000-8000-000000000000"
const PNG = btoa("not really a png")

function bucket(day = new Date()) {
  const objects = new Map<
    string,
    { bytes: Uint8Array; meta: Record<string, string>; uploaded: Date }
  >()
  return {
    objects,
    get: async (key: string) => {
      const o = objects.get(key)
      return o
        ? { arrayBuffer: async () => o.bytes.buffer as ArrayBuffer }
        : null
    },
    put: async (
      key: string,
      bytes: Uint8Array,
      options: { customMetadata: Record<string, string> }
    ) => {
      objects.set(key, { bytes, meta: options.customMetadata, uploaded: day })
    },
    list: async ({ prefix }: { prefix: string }) => ({
      objects: [...objects]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, o]) => ({ key, uploaded: o.uploaded })),
      truncated: false,
    }),
  }
}

type Call = { url: string; body: Record<string, unknown> }

/** An OpenRouter that answers the prompt call and draws every image unless told to refuse. */
function openrouter(
  options: {
    refuse?: (body: Call["body"]) => boolean
    noPrompts?: boolean
  } = {}
) {
  const calls: Call[] = []
  const fetcher = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Call["body"]
    calls.push({ url, body })
    if (url.endsWith("/chat/completions")) {
      if (options.noPrompts) return new Response("down", { status: 503 })
      const slots = JSON.parse(
        (body.messages as { content: string }[])[1]?.content ?? "{}"
      ).slots as { id: string }[]
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                style: "Soft morning light, 35mm, sage plant.",
                subjects: Object.fromEntries(
                  slots.map((s) => [s.id, `A bright room for ${s.id}`])
                ),
              }),
            },
          },
        ],
      })
    }
    if (options.refuse?.(body)) return new Response("no", { status: 400 })
    return Response.json({
      data: [{ b64_json: PNG, media_type: "image/png" }],
      usage: { cost: 0.034 },
    })
  }) as unknown as typeof fetch
  return { calls, fetcher }
}

const slot = (
  id: string,
  section: string,
  extra: Record<string, unknown> = {}
) => ({
  id,
  page: "home",
  section,
  aspect: "4:3",
  resolution: "1K",
  subject: `a sunlit ${id}, with a plant, on a table`,
  alt: id,
  source: "generated",
  ...extra,
})

const plan = (ids: [string, string][]) =>
  ({
    images: ids.map(([id, section]) => slot(id, section)),
    pages: [
      {
        page: "home",
        sections: [...new Set(ids.map(([, s]) => s))].map((kind) => ({
          kind,
          variant: kind === "service_cards" ? "photo_cards" : "default",
          purpose: "x",
          content_notes: null,
        })),
      },
    ],
  }) as never

const BRIEF = { industry: "cleaning", imageStyle: "airy", palette: "sage" }
const images = (calls: Call[]) => calls.filter((c) => c.url.endsWith("/images"))

describe("the photo director", () => {
  it("draws the hero at 2K first, the rest at 1K with the hero as a reference, and stores them", async () => {
    const sites = bucket()
    const { calls, fetcher } = openrouter()
    const told: string[] = []
    const out = await directPhotos({
      env: { OPENROUTER_API_KEY: "k", SITES: sites },
      orgId: ORG,
      plan: plan([
        ["kitchen", "service_cards"],
        ["hero", "hero"],
      ]),
      brief: BRIEF,
      fetch: fetcher,
      // The build's per-photo progress: one call per settled slot.
      onSlot: (r) => told.push(r.slot_id),
    })
    expect(told.toSorted((a, b) => a.localeCompare(b))).toEqual([
      "hero",
      "kitchen",
    ])
    const drawn = images(calls)
    expect(drawn).toHaveLength(2)
    expect(drawn[0]?.body).toMatchObject({
      model: PHOTO_MODEL,
      resolution: "2K",
    })
    expect(drawn[0]?.body.input_references).toBeUndefined()
    expect(drawn[0]?.body.prompt).toContain(NEVER)
    expect(drawn[1]?.body).toMatchObject({ resolution: "1K" })
    expect(drawn[1]?.body.input_references).toHaveLength(1)
    expect(out.map((r) => [r.slot_id, r.status])).toEqual([
      ["hero", "generated"],
      ["kitchen", "generated"],
    ])
    const [key] = [...sites.objects.keys()]
    expect(key).toMatch(new RegExp(`^generated/${ORG}/[0-9a-f-]{36}\\.png$`))
    expect([...sites.objects.values()][0]?.meta).toMatchObject({
      model: PHOTO_MODEL,
      cost_usd: "0.034",
    })
  })

  it("reuses a stored photo and pays nothing on a rebuild", async () => {
    const sites = bucket()
    const input = {
      env: { OPENROUTER_API_KEY: "k", SITES: sites },
      orgId: ORG,
      plan: plan([["hero", "hero"]]),
      brief: BRIEF,
    }
    await directPhotos({ ...input, fetch: openrouter().fetcher })
    const second = openrouter()
    const out = await directPhotos({ ...input, fetch: second.fetcher })
    expect(second.calls).toHaveLength(0)
    expect(out[0]).toMatchObject({ status: "reused", cost_usd: 0 })
  })

  it("never draws a claim section, and falls back instead of failing on a refusal", async () => {
    const { calls, fetcher } = openrouter({ refuse: () => true })
    const out = await directPhotos({
      env: { OPENROUTER_API_KEY: "k", SITES: bucket() },
      orgId: ORG,
      plan: plan([
        ["team", "about"],
        ["hero", "hero"],
      ]),
      brief: BRIEF,
      fetch: fetcher,
    })
    expect(out.map((r) => [r.slot_id, r.status, r.reason])).toEqual([
      ["hero", "fallback", "http 400"],
      ["team", "fallback", "claim section"],
    ])
    // The hero was tried twice (full subject, then the simplified one); the team never.
    expect(images(calls)).toHaveLength(2)
    expect(String(images(calls)[1]?.body.prompt)).toContain("a sunlit hero")
    expect(String(images(calls)[1]?.body.prompt)).not.toContain("with a plant")
  })

  it("still draws when the prompt writer is down", async () => {
    const { calls, fetcher } = openrouter({ noPrompts: true })
    const out = await directPhotos({
      env: { OPENROUTER_API_KEY: "k", SITES: bucket() },
      orgId: ORG,
      plan: plan([["hero", "hero"]]),
      brief: BRIEF,
      fetch: fetcher,
    })
    expect(out[0]?.status).toBe("generated")
    expect(String(images(calls)[0]?.body.prompt)).toContain("a sunlit hero")
  })

  it("stops at the build cap and at the day's cap", async () => {
    const ids = Array.from(
      { length: MAX_PER_BUILD + 2 },
      (_, i) =>
        [`s${i}`, i === 0 ? "hero" : "service_cards"] as [string, string]
    )
    const { fetcher } = openrouter()
    const out = await directPhotos({
      env: { OPENROUTER_API_KEY: "k", SITES: bucket() },
      orgId: ORG,
      plan: plan(ids),
      brief: BRIEF,
      fetch: fetcher,
    })
    expect(out.filter((r) => r.status === "generated")).toHaveLength(
      MAX_PER_BUILD
    )
    expect(out.filter((r) => r.reason === "build cap")).toHaveLength(2)

    const busy = bucket()
    for (let i = 0; i < MAX_PER_DAY; i++)
      await busy.put(`generated/${ORG}/old${i}.png`, new Uint8Array(), {
        customMetadata: {},
      })
    const day = openrouter()
    const capped = await directPhotos({
      env: { OPENROUTER_API_KEY: "k", SITES: busy },
      orgId: ORG,
      plan: plan([["hero", "hero"]]),
      brief: BRIEF,
      fetch: day.fetcher,
    })
    expect(capped[0]).toMatchObject({ status: "fallback", reason: "daily cap" })
    expect(images(day.calls)).toHaveLength(0)
  })

  it("copies the photos into src/assets/generated", async () => {
    const sites = bucket()
    const out = await directPhotos({
      env: { OPENROUTER_API_KEY: "k", SITES: sites },
      orgId: ORG,
      plan: plan([["hero", "hero"]]),
      brief: BRIEF,
      fetch: openrouter().fetcher,
    })
    const written: string[] = []
    const placed = await placeGenerated(
      {
        exec: async () => undefined,
        writeFile: async (path) => void written.push(path),
      },
      sites,
      out
    )
    expect(placed).toEqual({ hero: "src/assets/generated/hero.png" })
    expect(written).toEqual(["/workspace/site/src/assets/generated/hero.png"])
  })
})

describe("the plan once its photos are made", () => {
  const result = (slot_id: string, status: "generated" | "fallback") => ({
    slot_id,
    status,
    asset_id: status === "generated" ? `${slot_id}-asset` : null,
    key: status === "generated" ? `generated/o/${slot_id}.png` : null,
    content_type: status === "generated" ? "image/png" : null,
    cost_usd: null,
    reason: status === "fallback" ? "refused" : null,
  })

  it("drops a slot that fell back, ids the made one and keeps the owner's", () => {
    const own = slot("own", "about", {
      source: "upload",
      asset_id: "20000001-0000-4000-8000-000000000000",
    })
    const { images: kept, step } = applyPhotos(
      [slot("hero", "hero"), slot("kitchen", "gallery"), own] as never,
      [result("hero", "generated"), result("kitchen", "fallback")]
    )
    expect(kept.map((s) => [s.id, s.asset_id])).toEqual([
      ["hero", "hero-asset"],
      ["own", "20000001-0000-4000-8000-000000000000"],
    ])
    expect(step).toEqual({
      generated: 1,
      fell_back: 1,
      files: [
        {
          slot_id: "hero",
          status: "generated",
          key: "generated/o/hero.png",
          content_type: "image/png",
        },
      ],
    })
  })
})
