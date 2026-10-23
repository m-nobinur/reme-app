import {
  type Asset,
  ErrorEnvelope,
  FactList,
  KeptLogo,
  LOGO_ROUND_WAITS,
  LOGO_ROUNDS_MAX,
  LOGO_STYLES,
  LOGO_VARIANTS,
  LogoRound,
  LogoRounds,
  type LogoType,
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
  hasAlpha,
  LOGO_MODELS,
  nextRoundAt,
  readLogos,
  roundView,
  supportOf,
  symbolsOf,
  useDaily,
  waitBefore,
} from "../src/logo.ts"
import { logoReference } from "../src/logo-references.ts"
import {
  changesPrompt,
  colourName,
  initialsOf,
  LOGO_STYLE_WORDS,
  logoPrompt,
  variantStyles,
} from "../src/logo-style.ts"
import { owner, stubOrchestrator } from "./owner-fixture.ts"
import { stubJwksFetch } from "./sealed-session.ts"

const palette = PALETTES[0] as (typeof PALETTES)[number]
const { primary: light, ink: dark } = palette
const brief = {
  description: "Something with a home",
  colors: [palette.primary, palette.ink],
  type: "lockup" as const,
  style: "minimal" as const,
}
const subject = { name: "Bright Homes", trade: "domestic cleaning" }

describe("the logo prompt", () => {
  it("quotes the name, and binds each colour by name to a part", () => {
    const prompt = logoPrompt({
      subject,
      brief,
      style: "minimal",
      symbol: "a droplet with a roof",
    })
    expect(prompt).toContain('"Bright Homes"')
    expect(prompt).toContain(
      "Flat 2D vector logo, built from solid-colour shapes with crisp, clean edges: a combination mark"
    )
    expect(prompt).toContain(LOGO_STYLE_WORDS.minimal)
    expect(prompt).toContain("Use a clean, balanced level of detail")
    expect(prompt).toContain(
      'Set the company name "Bright Homes" as clean, evenly-spaced lettering with every letter clear, complete and correctly spelled.'
    )
    expect(prompt).toContain(
      `the icon is ${colourName(palette.primary)} (${palette.primary}), the brand colour, and the company-name text is ${colourName(palette.ink)} (${palette.ink})`
    )
    expect(prompt).toContain(
      "even where this style is conventionally drawn in other colours. Every fill is solid and flat, with no unrelated colours introduced."
    )
    expect(prompt).toContain("Idea: a droplet with a roof")
    expect(prompt).toContain("fully transparent background")
    expect(prompt).toContain("scalable from favicon to signage")
    expect(prompt).toContain("Additional direction: Something with a home")
  })

  it("lets only gradient and 3D styles shade, and draws them as polished rather than flat", () => {
    const of = (style: "gradient" | "three_d" | "retro") =>
      logoPrompt({ subject, brief, style, symbol: null })
    for (const style of ["gradient", "three_d"] as const) {
      expect(of(style)).toContain(
        "Modern, polished logo with smooth, clean rendering"
      )
      expect(of(style)).toContain("Lighter and darker tones")
      expect(of(style)).not.toContain("Flat 2D vector logo")
    }
    expect(of("retro")).toContain("Flat 2D vector logo")
    expect(of("retro")).not.toContain("Lighter and darker tones")
  })

  it("letters in the darkest colour, adds the supporting one, and says the example is for layout and look only", () => {
    const prompt = logoPrompt({
      subject,
      brief: { ...brief, colors: [light] },
      style: "luxury",
      symbol: null,
      support: dark,
      reference: true,
    })
    expect(prompt).toContain(`(${light}), the brand colour, and the company`)
    expect(prompt).toContain(`text is ${colourName(dark)} (${dark})`)
    expect(prompt).toContain(
      "Take inspiration from the attached reference picture's composition, shapes and overall feel"
    )
    expect(prompt).toContain("never its name, its symbol or its colours")
    // A lighter supporting colour is the accent; the brand colour letters.
    const lighter = logoPrompt({
      subject,
      brief: { ...brief, colors: [dark] },
      style: "luxury",
      symbol: null,
      support: light,
    })
    expect(lighter).toContain(`(${dark}), the brand colour, and the company`)
    expect(lighter).toContain(`text is ${colourName(dark)} (${dark})`)
    expect(lighter).not.toContain("reference picture")
  })

  it("takes the director's supporting colour only as a hex", () => {
    expect(supportOf({ support: ` ${light.toUpperCase()} ` })).toBe(light)
    expect(supportOf({ support: "a warm tone" })).toBeUndefined()
    expect(supportOf({ support: "fff" })).toBeUndefined()
    expect(supportOf(null)).toBeUndefined()
  })

  it("letters only what its type letters", () => {
    const of = (type: LogoType, name = subject.name) =>
      logoPrompt({
        subject: { ...subject, name },
        brief: { ...brief, type },
        style: "luxury",
        symbol: null,
      })
    for (const type of ["icon", "abstract"] as const) {
      expect(of(type)).toContain("purely graphic symbol with no lettering")
      expect(of(type)).not.toContain('company name "Bright Homes"')
    }
    const monogram = of("monogram")
    expect(monogram).toContain('only the initials "BH"')
    expect(monogram).not.toContain('company name "Bright Homes"')
    expect(of("lockup")).toContain('company name "Bright Homes"')
    expect(of("emblem")).toContain('company name "Bright Homes"')
    const wordmark = of("wordmark")
    expect(wordmark).toContain('company name "Bright Homes" as the whole logo')
    expect(wordmark).not.toContain("purely graphic symbol")
    expect(initialsOf("Smith & Sons Cleaning Co")).toBe("SSC")
  })

  it("draws a surprise round in four different styles, and a picked one in four alike", () => {
    for (let i = 0; i < 20; i++) {
      const styles = variantStyles("surprise")
      expect(styles).toHaveLength(LOGO_VARIANTS)
      expect(new Set(styles).size).toBe(LOGO_VARIANTS)
      expect(styles.every((each) => LOGO_STYLES.includes(each))).toBe(true)
    }
    expect(variantStyles("retro")).toEqual(Array(LOGO_VARIANTS).fill("retro"))
  })

  it("keeps a name's quotes from breaking out of its own", () => {
    const prompt = logoPrompt({
      subject: { name: 'The "Best" Clean', trade: "cleaning" },
      brief: { ...brief, type: "emblem" },
      style: "retro",
      symbol: null,
    })
    expect(prompt).toContain(`"The 'Best' Clean"`)
  })

  it("asks a round of changes to change only what was asked", () => {
    const prompt = changesPrompt({
      subject,
      brief,
      style: "minimal",
      changes: "Make the roof red",
    })
    expect(prompt).toContain("Make the roof red")
    expect(prompt).toContain("Change only that.")
    expect(prompt).toContain('"Bright Homes"')
    expect(
      changesPrompt({
        subject,
        brief: { ...brief, type: "icon" },
        style: "minimal",
        changes: "Bigger",
      })
    ).toContain("no lettering")
  })

  it("takes the director's ideas that are words, at most one per variant", () => {
    expect(
      symbolsOf({ ideas: [" a mop ", 4, "", "a bucket", "x", "y", "z"] })
    ).toEqual(["a mop", "a bucket", "x", "y"])
    expect(symbolsOf({ beside: "a mop" })).toEqual([])
    expect(symbolsOf(null)).toEqual([])
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

/** A PNG's bytes up to its first pixels: signature, header of the colour type, extra empty chunks, one IDAT. */
function pngOf(colorType: number, ...before: string[]) {
  const chunk = (name: string, data: number[] = []) => [
    0,
    0,
    0,
    data.length,
    ...[...name].map((c) => c.charCodeAt(0)),
    ...data,
    0,
    0,
    0,
    0,
  ]
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, colorType, 0, 0, 0]),
    ...before.flatMap((name) => chunk(name)),
    ...chunk("IDAT", [0]),
  ])
}
const PNG = pngOf(6)
const ORG = "org-a"
const TOOL_CALL = "call_1"

/** The image endpoint, failing for the prompts `fails` picks, recording each model asked. */
function images(
  fails: (model: string, prompt: string) => boolean = () => false,
  bytes: Uint8Array = PNG
) {
  const asked: {
    model: string
    prompt: string
    reference: boolean
    /** The attached picture's url, when there is one. */
    url?: string
  }[] = []
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    asked.push({
      model: body.model,
      prompt: body.prompt,
      reference: Boolean(body.input_references),
      url: body.input_references?.[0]?.image_url?.url,
    })
    if (fails(body.model, body.prompt))
      return new Response("{}", { status: 502 })
    return Response.json({
      data: [{ b64_json: btoa(String.fromCharCode(...bytes)) }],
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
    planned: Array.from(
      { length: LOGO_VARIANTS },
      (_, i) => `0000000${i}-0000-4000-8000-000000000000`
    ),
    styles: variantStyles("minimal"),
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

  it("draws four ideas for one type, falling back per variant, and lists them in planned order", async () => {
    const { sites, env, read } = await setup()
    const asked = images(
      (model, prompt) =>
        model === LOGO_MODELS[0].id && prompt.includes("Idea: a bucket")
    )
    await drawRound(env, job, {
      director: async () => ({
        ideas: ["a mop", "a bucket", "a cloth", "a spray"],
      }),
    })
    const done = await read()
    expect(done.status).toBe("ready")
    expect(done.variants).toEqual(done.planned)
    expect(typeof done.finished_at).toBe("string")
    expect(asked.filter((a) => a.model === LOGO_MODELS[1].id)).toHaveLength(1)
    expect(
      asked.filter((a) => a.prompt.includes("a combination mark"))
    ).toHaveLength(asked.length)
    expect(
      asked.find((a) => a.prompt.includes("Idea: a mop"))?.prompt
    ).toContain(LOGO_STYLE_WORDS.minimal)
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
    expect(asked).toHaveLength(LOGO_VARIANTS * LOGO_MODELS.length)

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
    await drawRound(env, job, { director: async () => ({ ideas: ["unused"] }) })
    expect(
      asked.every((a) => a.reference && a.prompt.includes("Make the roof red"))
    ).toBe(true)
    expect(asked.some((a) => a.prompt.includes("Idea:"))).toBe(false)
  })

  it("draws a surprise round in the four styles the manifest holds", async () => {
    const styles = variantStyles("surprise")
    const { env } = await setup({ styles })
    const asked = images()
    await drawRound(env, job, { director: null })
    const looks = asked.map((a) =>
      LOGO_STYLES.find((each) => a.prompt.includes(LOGO_STYLE_WORDS[each]))
    )
    expect(new Set(looks).size).toBe(LOGO_VARIANTS)
  })

  it("hands each variant of a first round the example for its own type and style", async () => {
    const styles = variantStyles("surprise")
    const { env } = await setup({
      styles,
      brief: { ...brief, type: "emblem" },
    })
    const asked = images()
    await drawRound(env, job, { director: null })
    expect(asked).toHaveLength(LOGO_VARIANTS)
    const urls = asked.map((a) => a.url)
    expect(new Set(urls).size).toBe(LOGO_VARIANTS)
    for (const style of styles) {
      const example = `data:image/webp;base64,${Buffer.from(logoReference("emblem", style)).toString("base64")}`
      expect(urls).toContain(example)
    }
    expect(asked.every((a) => a.prompt.includes("reference picture"))).toBe(
      true
    )
  })

  it("gives a one-colour brief the director's supporting colour, and a many-colour one its own", async () => {
    const one = await setup({ brief: { ...brief, colors: [light] } })
    const askedOne = images()
    await drawRound(one.env, job, {
      director: async () => ({ ideas: [], support: dark }),
    })
    expect(
      askedOne.every((a) =>
        a.prompt.includes(`text is ${colourName(dark)} (${dark})`)
      )
    ).toBe(true)
    const other = (PALETTES[1] as (typeof PALETTES)[number]).primary
    const many = await setup()
    const askedMany = images()
    await drawRound(many.env, job, {
      director: async () => ({ ideas: [], support: other }),
    })
    expect(askedMany.some((a) => a.prompt.includes(other))).toBe(false)
  })

  it("keeps only pictures with alpha: an opaque one falls to the next model, then loses its tile", async () => {
    const { env, read } = await setup()
    const asked = images(() => false, pngOf(2))
    await drawRound(env, job, { director: null })
    expect(asked).toHaveLength(LOGO_VARIANTS * LOGO_MODELS.length)
    expect((await read()).status).toBe("failed")
  })
})

describe("a PNG with alpha", () => {
  it("is told by its colour type or a tRNS chunk, never by the model's word", () => {
    expect(hasAlpha(pngOf(6))).toBe(true)
    expect(hasAlpha(pngOf(4))).toBe(true)
    expect(hasAlpha(pngOf(3, "PLTE", "tRNS"))).toBe(true)
    expect(hasAlpha(pngOf(3, "PLTE"))).toBe(false)
    expect(hasAlpha(pngOf(2))).toBe(false)
    expect(hasAlpha(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe(false)
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

describe("the wait between rounds", () => {
  const T = Date.parse("2026-10-23T12:00:00Z")
  const done = (round: number, ago: number, extra: object = {}) =>
    manifest({
      round,
      status: "ready",
      started_at: new Date(T - ago - 20_000).toISOString(),
      finished_at: new Date(T - ago).toISOString(),
      variants: [`0000000${round}-0000-4000-8000-000000000000`],
      ...extra,
    }) as Parameters<typeof nextRoundAt>[0][number]

  it("repeats the last wait", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 12].map(waitBefore)).toEqual([
      ...LOGO_ROUND_WAITS,
      LOGO_ROUND_WAITS.at(-1),
      LOGO_ROUND_WAITS.at(-1),
    ])
  })

  it("counts from the finish of the round before", () => {
    expect(nextRoundAt([], T)).toBeNull()
    // The first draft and one redesign go at once.
    expect(nextRoundAt([done(1, 0)], T)).toBeNull()
    expect(nextRoundAt([done(1, 5000), done(2, 10_000)], T)).toBe(
      T - 10_000 + 60_000
    )
    expect(nextRoundAt([done(1, 0), done(2, 61_000)], T)).toBeNull()
    expect(nextRoundAt([done(1, 0), done(2, 0), done(3, 0)], T)).toBe(
      T + 300_000
    )
  })

  it("waits for nothing while a round draws or after one failed", () => {
    const failed = done(2, 0, { status: "failed", variants: [] })
    expect(nextRoundAt([done(1, 0), failed], T)).toBeNull()
    const drawing = done(2, 0, {
      status: "drawing",
      finished_at: undefined,
      started_at: new Date(T).toISOString(),
      variants: [],
    })
    expect(nextRoundAt([done(1, 0), drawing], T)).toBeNull()
  })

  it("ends the offer once the rounds are used up", () => {
    const all = Array.from({ length: LOGO_ROUNDS_MAX }, (_, i) =>
      done(i + 1, 0)
    )
    expect(nextRoundAt(all, T)).toBeUndefined()
  })

  it("takes a round that lapsed with no finish time to have ended at its deadline", () => {
    const lapsed = done(2, 0, {
      status: "drawing",
      finished_at: undefined,
      started_at: new Date(T - DRAW_DEADLINE_MS - 1000).toISOString(),
    })
    expect(nextRoundAt([done(1, 0), lapsed], T)).toBe(T - 1000 + 60_000)
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

  it("refuses a round asked for early with 429, the seconds left and plain words, and lets a failed one be tried at once", async () => {
    const sites = bucket()
    const put = (round: number, extra: object) =>
      sites.put(
        `logos/${ORG}/${TOOL_CALL}/${round}.json`,
        JSON.stringify(
          manifest({
            round,
            key: `k${round}`,
            status: "ready",
            variants: [`0000000${round}-0000-4000-8000-000000000000`],
            finished_at: new Date().toISOString(),
            ...extra,
          })
        )
      )
    await put(1, {})
    await put(2, { finished_at: new Date(Date.now() - 10_000).toISOString() })
    const early = await drawLogos(post("k3", {}), envWith(sites), kit, caller)
    expect(early.status).toBe(429)
    const seconds = Number(early.headers.get("retry-after"))
    expect(seconds).toBeGreaterThanOrEqual(49)
    expect(seconds).toBeLessThanOrEqual(50)
    const envelope = ErrorEnvelope.parse(await early.json())
    expect(envelope.code).toBe("logos.wait")
    expect(envelope.message).toBe(
      "Your next round opens in a minute. Until then, pick the logo you like best."
    )
    expect(sites.objects.has(`logos/${ORG}/${TOOL_CALL}/3.json`)).toBe(false)

    const read = LogoRounds.parse(
      await (
        await readLogos(
          new Request(`https://api.test/logos?tool_call_id=${TOOL_CALL}`),
          envWith(sites),
          caller
        )
      ).json()
    )
    expect(Date.parse(read.next_at as string) - Date.now()).toBeGreaterThan(
      48_000
    )

    // A failed latest round is replaced at once: past the wait, on to the facts.
    await put(2, { status: "failed", variants: [] })
    await expect(
      drawLogos(post("k4", {}), envWith(sites), kit, caller)
    ).rejects.toThrow()
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
