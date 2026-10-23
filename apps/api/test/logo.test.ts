import {
  type Asset,
  ErrorEnvelope,
  FactList,
  KeptLogo,
  LOGO_ROUNDS_MAX,
  LogoRound,
  PALETTES,
  UploadedAssets,
} from "@workspace/contracts"
import { type Tenancy, tenancy } from "@workspace/db"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import type { Owner } from "../src/changes.ts"
import {
  DRAW_DEADLINE_MS,
  drawLogos,
  drawRound,
  LOGO_MODELS,
  roundView,
  symbolsOf,
  useDaily,
} from "../src/logo.ts"
import {
  COMPOSITIONS,
  changesPrompt,
  colourName,
  logoPrompt,
  spelled,
} from "../src/logo-style.ts"
import { owner, stubOrchestrator } from "./owner-fixture.ts"
import { stubJwksFetch } from "./sealed-session.ts"

const palette = PALETTES[0] as (typeof PALETTES)[number]
const brief = {
  description: "Something with a home",
  colors: [palette.primary, palette.ink],
  style: "friendly" as const,
}
const subject = { name: "Bright Homes", trade: "domestic cleaning" }

describe("the logo prompt", () => {
  it("quotes and spells the name, and binds each colour by name to a part", () => {
    const prompt = logoPrompt({
      subject,
      brief,
      composition: "beside",
      symbol: "a droplet with a roof",
      transparent: true,
    })
    expect(prompt).toContain('"Bright Homes"')
    expect(prompt).toContain("B-R-I-G-H-T H-O-M-E-S")
    expect(prompt).toContain(
      `${colourName(palette.primary)} (${palette.primary}) for the main shapes`
    )
    expect(prompt).toContain(`(${palette.ink}) for the lettering`)
    expect(prompt).toContain("Symbol idea: a droplet with a roof")
    expect(prompt).toContain("fully transparent background")
    expect(prompt).toContain("Owner's direction: Something with a home")
  })

  it("asks a model without transparency for a flat field, and a long name for a monogram", () => {
    const prompt = logoPrompt({
      subject: { name: "Smith and Sons Cleaning", trade: "cleaning" },
      brief: { ...brief, description: "" },
      composition: "lettering",
      symbol: null,
      transparent: false,
    })
    expect(prompt).toContain("perfectly even, flat")
    expect(prompt).not.toContain("transparent")
    expect(prompt).toContain(
      'monogram built only from the initials of "Smith and Sons Cleaning"'
    )
    expect(prompt).not.toContain("Owner's direction")
    expect(prompt).not.toContain("Symbol idea")
  })

  it("keeps a name's quotes from breaking out of its own", () => {
    expect(spelled("Jo's")).toBe("J-O-'-S")
    const prompt = logoPrompt({
      subject: { name: 'The "Best" Clean', trade: "cleaning" },
      brief,
      composition: "badge",
      symbol: null,
      transparent: true,
    })
    expect(prompt).toContain(`"The 'Best' Clean"`)
  })

  it("asks a round of changes to change only what was asked", () => {
    const prompt = changesPrompt({
      subject,
      brief,
      changes: "Make the roof red",
      transparent: true,
    })
    expect(prompt).toContain("Make the roof red")
    expect(prompt).toContain("Change only that.")
    expect(prompt).toContain('"Bright Homes"')
  })

  it("takes only the director's ideas that are words, one per layout", () => {
    expect(
      symbolsOf({ beside: " a mop ", above: 4, badge: "", extra: "x" })
    ).toEqual({
      beside: "a mop",
    })
    expect(symbolsOf(null)).toEqual({})
  })
})

/** An R2 stand-in with etags, conditional puts, heads and prefix lists. */
function bucket() {
  const objects = new Map<
    string,
    {
      bytes: Uint8Array
      etag: string
      type?: string
      meta?: Record<string, string>
    }
  >()
  let version = 0
  const view = (key: string) => {
    const o = objects.get(key)
    if (!o) return null
    return {
      key,
      etag: o.etag,
      size: o.bytes.byteLength,
      httpMetadata: { contentType: o.type },
      customMetadata: o.meta,
      body: new Blob([o.bytes]).stream(),
      json: async () => JSON.parse(new TextDecoder().decode(o.bytes)),
      arrayBuffer: async () => o.bytes.slice().buffer,
    }
  }
  return {
    objects,
    get: async (key: string) => view(key),
    head: async (key: string) => view(key),
    list: async ({ prefix }: { prefix: string }) => ({
      objects: [...objects.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((key) => ({ key })),
    }),
    put: async (
      key: string,
      value: string | Uint8Array | File,
      options: {
        onlyIf?: Headers | { etagMatches?: string }
        httpMetadata?: { contentType?: string }
        customMetadata?: Record<string, string>
      } = {}
    ) => {
      const current = objects.get(key)
      const only = options.onlyIf
      if (
        only instanceof Headers &&
        only.get("if-none-match") === "*" &&
        current
      )
        return null
      if (
        only &&
        !(only instanceof Headers) &&
        only.etagMatches !== current?.etag
      )
        return null
      objects.set(key, {
        bytes:
          typeof value === "string"
            ? new TextEncoder().encode(value)
            : value instanceof File
              ? new Uint8Array(await value.arrayBuffer())
              : value,
        etag: `e${++version}`,
        type: options.httpMetadata?.contentType,
        meta: options.customMetadata,
      })
      return view(key)
    },
  }
}

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2,
])
const ORG = "org-a"
const TOOL_CALL = "call_1"

/** The image endpoint, failing for the prompts `fails` picks, recording each model asked. */
function images(
  fails: (model: string, prompt: string) => boolean = () => false
) {
  const asked: { model: string; prompt: string; reference: boolean }[] = []
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    asked.push({
      model: body.model,
      prompt: body.prompt,
      reference: Boolean(body.input_references),
    })
    if (fails(body.model, body.prompt))
      return new Response("{}", { status: 502 })
    return Response.json({
      data: [{ b64_json: btoa(String.fromCharCode(...PNG)) }],
      usage: { cost: 0.01 },
    })
  })
  return asked
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const manifestAt = `logos/${ORG}/${TOOL_CALL}/1.json`

function manifest(overrides: object = {}) {
  return {
    round: 1,
    status: "drawing",
    key: "k1",
    started_at: new Date().toISOString(),
    subject: { ...subject, offerings: [] },
    brief,
    planned: COMPOSITIONS.map(
      (_, i) => `0000000${i}-0000-4000-8000-000000000000`
    ),
    variants: [],
    ...overrides,
  }
}

const job = {
  kind: "logo" as const,
  orgId: ORG,
  toolCallId: TOOL_CALL,
  round: 1,
}

describe("drawing a round in the queue", () => {
  const setup = async (overrides: object = {}) => {
    const sites = bucket()
    await sites.put(manifestAt, JSON.stringify(manifest(overrides)))
    const env = { SITES: sites, OPENROUTER_API_KEY: "test" } as unknown as Env
    const read = async () => (await sites.get(manifestAt))?.json()
    return { sites, env, read }
  }

  it("draws four layouts, falling back per variant, and lists them in layout order", async () => {
    const { sites, env, read } = await setup()
    const asked = images(
      (model, prompt) =>
        model === LOGO_MODELS[0].id && prompt.includes("emblem or badge")
    )
    await drawRound(env, job, { director: async () => ({ beside: "a mop" }) })
    const done = await read()
    expect(done.status).toBe("ready")
    expect(done.variants).toEqual(done.planned)
    expect(asked.filter((a) => a.model === LOGO_MODELS[1].id)).toHaveLength(1)
    expect(
      asked.find((a) => a.prompt.includes("horizontal"))?.prompt
    ).toContain("Symbol idea: a mop")
    const stored = sites.objects.get(`generated/${ORG}/${done.planned[0]}.png`)
    expect(stored?.meta).toEqual({ use: "logo" })
    expect(stored?.type).toBe("image/png")
  })

  it("pays for nothing twice: a retry skips what is drawn, a finished round is left", async () => {
    const { sites, env, read } = await setup()
    const first = manifest().planned[0] as string
    await sites.put(`generated/${ORG}/${first}.png`, PNG)
    const asked = images()
    await drawRound(env, job, { director: null })
    expect(asked).toHaveLength(3)
    expect((await read()).variants).toHaveLength(4)
    await drawRound(env, job, { director: null })
    expect(asked).toHaveLength(3)
  })

  it("marks a round no model drew as failed, and leaves a lapsed one alone", async () => {
    const { env, read } = await setup()
    const asked = images(() => true)
    await drawRound(env, job, { director: null })
    expect((await read()).status).toBe("failed")
    expect(asked).toHaveLength(COMPOSITIONS.length * LOGO_MODELS.length)

    const lapsed = await setup({
      started_at: new Date(Date.now() - DRAW_DEADLINE_MS - 1000).toISOString(),
    })
    const none = images()
    await drawRound(lapsed.env, job, { director: null })
    expect(none).toHaveLength(0)
  })

  it("hands the picked variant to every call of a round of changes", async () => {
    const base = "aaaaaaaa-0000-4000-8000-000000000000"
    const { sites, env } = await setup({ base, changes: "Make the roof red" })
    await sites.put(`generated/${ORG}/${base}.png`, PNG)
    const asked = images()
    await drawRound(env, job, { director: async () => ({ beside: "unused" }) })
    expect(
      asked.every((a) => a.reference && a.prompt.includes("Make the roof red"))
    ).toBe(true)
    expect(asked.some((a) => a.prompt.includes("Symbol idea"))).toBe(false)
  })
})

describe("a round as the owner sees it", () => {
  it("is over once drawing passes its deadline: ready with what drew, else failed", () => {
    const late = Date.now() + DRAW_DEADLINE_MS + 1
    const empty = manifest() as Parameters<typeof roundView>[0]
    expect(roundView(empty).status).toBe("drawing")
    expect(roundView(empty, late).status).toBe("failed")
    const some = { ...empty, variants: [empty.planned[0] as string] }
    expect(roundView(some, late)).toEqual(
      LogoRound.parse({
        round: 1,
        status: "ready",
        variants: [{ id: empty.planned[0] }],
      })
    )
  })
})

describe("POST /logos before it draws", () => {
  const caller = { orgId: ORG, session: { workosUserId: "u" } } as Owner
  const kit = {} as Tenancy
  const post = (key: string, body: object) =>
    new Request("https://api.test/logos", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ tool_call_id: TOOL_CALL, brief, ...body }),
    })
  const envWith = (sites: ReturnType<typeof bucket>) =>
    ({ SITES: sites, OPENROUTER_API_KEY: "test" }) as unknown as Env

  it("replays the round a key started, and answers a second try with the round still drawing", async () => {
    const sites = bucket()
    await sites.put(manifestAt, JSON.stringify(manifest()))
    const replay = await drawLogos(post("k1", {}), envWith(sites), kit, caller)
    expect(replay.status).toBe(202)
    expect(LogoRound.parse(await replay.json()).round).toBe(1)
    const busy = await drawLogos(post("k2", {}), envWith(sites), kit, caller)
    expect(busy.status).toBe(202)
    expect(LogoRound.parse(await busy.json()).status).toBe("drawing")
  })

  it("refuses a round past the most, and changes to a picture it never drew", async () => {
    const sites = bucket()
    for (let round = 1; round <= LOGO_ROUNDS_MAX; round++) {
      await sites.put(
        `logos/${ORG}/${TOOL_CALL}/${round}.json`,
        JSON.stringify(
          manifest({ round, key: `k${round}`, status: "ready", variants: [] })
        )
      )
    }
    const over = await drawLogos(post("new", {}), envWith(sites), kit, caller)
    expect(over.status).toBe(409)
    expect(ErrorEnvelope.parse(await over.json()).code).toBe("logos.rounds")

    const fresh = bucket()
    await fresh.put(manifestAt, JSON.stringify(manifest({ status: "ready" })))
    const stranger = await drawLogos(
      post("k9", {
        changes: "Bigger",
        base: "bbbbbbbb-0000-4000-8000-000000000000",
      }),
      envWith(fresh),
      kit,
      caller
    )
    expect(stranger.status).toBe(400)
  })

  it("counts a daily allowance and stops at its cap", async () => {
    const env = envWith(bucket())
    expect(await useDaily(env, "logo-days/o", 2, "a")).toBe(true)
    expect(await useDaily(env, "logo-days/o", 2, "b")).toBe(true)
    expect(await useDaily(env, "logo-days/o", 2, "c")).toBe(false)
  })
})

const url = process.env.DATABASE_URL

describe.skipIf(!url)("POST /logos/:id/keep, on a live connection", () => {
  const kit: Tenancy = tenancy(url as string, { max: 2 })
  let realFetch: typeof fetch

  beforeAll(() => {
    realFetch = globalThis.fetch
    globalThis.fetch = stubJwksFetch()
  })

  afterAll(async () => {
    globalThis.fetch = realFetch
    await kit.close()
  })

  type Who = Awaited<ReturnType<typeof owner>>
  const keep = (who: Who, sites: ReturnType<typeof bucket>, id: string) =>
    who.call(stubOrchestrator(), `/logos/${id}/keep`, {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
      bindings: { SITES: sites },
    })
  const uploads = async (who: Who) => {
    const facts = FactList.parse(
      await (await who.call(stubOrchestrator(), "/facts")).json()
    ).facts
    const held = facts.find((f) => f.key === "media.uploads")?.value as
      | { items: Asset[] }
      | undefined
    return (held?.items ?? []).map((a) => [a.id, a.use])
  }

  it("copies a drawn logo to the uploads, then lets an uploaded one take its place", async () => {
    const who = await owner(kit, url as string, "logo-keep")
    const sites = bucket()
    const drawn = "cccccccc-0000-4000-8000-000000000000"
    await sites.put(`generated/${who.orgId}/${drawn}.png`, PNG, {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { use: "logo" },
    })
    const kept = await keep(who, sites, drawn)
    expect(kept.status).toBe(200)
    const { asset } = KeptLogo.parse(await kept.json())
    expect(asset).toMatchObject({
      id: drawn,
      use: "logo",
      content_type: "image/png",
    })
    expect(sites.objects.has(`uploads/${who.orgId}/${drawn}`)).toBe(true)
    expect(await uploads(who)).toEqual([[drawn, "logo"]])

    const form = new FormData()
    form.append("files", new File([PNG], "my-logo.png"))
    const sent = await who.call(stubOrchestrator(), "/assets", {
      method: "POST",
      body: form,
      headers: { "idempotency-key": crypto.randomUUID() },
      bindings: { SITES: sites },
    })
    const [own] = UploadedAssets.parse(await sent.json()).assets
    expect((await keep(who, sites, own?.id as string)).status).toBe(200)
    expect(await uploads(who)).toEqual([[own?.id, "logo"]])
  })

  it("keeps nothing that is not this org's drawn logo", async () => {
    const one = await owner(kit, url as string, "logo-keep-one")
    const other = await owner(kit, url as string, "logo-keep-other")
    const sites = bucket()
    const drawn = "dddddddd-0000-4000-8000-000000000000"
    await sites.put(`generated/${one.orgId}/${drawn}.png`, PNG, {
      customMetadata: { use: "logo" },
    })
    expect((await keep(other, sites, drawn)).status).toBe(404)
    const photo = "eeeeeeee-0000-4000-8000-000000000000"
    await sites.put(`generated/${one.orgId}/${photo}.png`, PNG)
    expect((await keep(one, sites, photo)).status).toBe(404)
  })
})
