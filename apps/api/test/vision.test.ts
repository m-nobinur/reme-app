import {
  type Asset,
  ErrorEnvelope,
  LOGO_PALETTES_LINES,
  LogoPalettes,
  PALETTE_AA_PAIRS,
  PaletteFromImage,
} from "@workspace/contracts"
import type { Tenancy } from "@workspace/db"
import { MockLanguageModelV4 } from "ai/test"
import { describe, expect, it } from "vitest"
import type { Owner } from "../src/changes.ts"
import { DAILY_CAP_USD } from "../src/cos/turns.ts"
import { PLANNER, worstCall } from "../src/onboarding-agent.ts"
import { contrast, paletteRoles, readableStops } from "../src/palette.ts"
import {
  finishedPalettes,
  logoPalettes,
  logoPalettesOf,
  looksOf,
  missingOf,
  paletteFromImage,
  paletteOf,
} from "../src/vision.ts"
import { readFacts } from "../src/workspace.ts"
import { ledger } from "./spend-ledger.ts"

/** `#rrggbb` from channels, so no colour literal sits in the code. */
const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`
const rgb = (h: string) =>
  [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ]

const WHITE = [255, 255, 255] as [number, number, number]

describe("a palette read from a picture", () => {
  it("brings ink on paper and text on primary up to AA", () => {
    // A pale grey ink on cream and a light yellow primary: neither passes.
    const stops = readableStops({
      paper: hex(250, 245, 235),
      tint: hex(240, 230, 210),
      primary: hex(240, 200, 80),
      ink: hex(170, 170, 170),
    })
    expect(contrast(rgb(stops.ink), rgb(stops.paper))).toBeGreaterThanOrEqual(
      4.5
    )
    const onPrimary = Math.max(
      contrast(rgb(stops.primary), WHITE),
      contrast(rgb(stops.primary), rgb(stops.ink))
    )
    expect(onPrimary).toBeGreaterThanOrEqual(4.5)
    expect(stops.paper).toBe(hex(250, 245, 235))
  })

  it("lifts ink on a dark paper rather than darkening it, and leaves passing stops alone", () => {
    const dark = readableStops({
      paper: hex(18, 21, 26),
      tint: hex(28, 33, 41),
      primary: hex(201, 161, 91),
      ink: hex(90, 90, 90),
    })
    expect(
      contrast(rgb(dark.ink), rgb(hex(18, 21, 26)))
    ).toBeGreaterThanOrEqual(4.5)
    const fine = {
      paper: hex(255, 255, 255),
      tint: hex(238, 243, 248),
      primary: hex(30, 58, 95),
      ink: hex(15, 27, 42),
    }
    expect(readableStops(fine)).toEqual(fine)
  })

  it("makes six roles in which every pair the site reads holds at AA, a dark page too", () => {
    for (const stops of [
      // A light amber on cream, and a dim ink: most of it must move.
      {
        paper: hex(253, 250, 244),
        tint: hex(250, 237, 210),
        primary: hex(242, 157, 14),
        ink: hex(120, 110, 100),
      },
      // A dark page with a muted gold.
      {
        paper: hex(30, 40, 55),
        tint: hex(42, 55, 74),
        primary: hex(160, 104, 9),
        ink: hex(200, 200, 200),
      },
    ]) {
      const roles = paletteRoles(stops)
      for (const { text, on } of PALETTE_AA_PAIRS) {
        expect(
          contrast(rgb(roles[text]), rgb(roles[on])),
          `${text} on ${on}`
        ).toBeGreaterThanOrEqual(4.5)
      }
      expect(roles.paper).toBe(stops.paper)
    }
  })

  it("takes only colours, lower case, with a name or a plain one", () => {
    expect(
      paletteOf({
        paper: "not a colour",
        tint: hex(1, 1, 1),
        primary: hex(1, 1, 1),
        ink: hex(1, 1, 1),
      })
    ).toBeNull()
    const read = paletteOf({
      paper: hex(250, 250, 250).toUpperCase(),
      tint: hex(230, 240, 250),
      primary: hex(30, 58, 95),
      ink: hex(15, 27, 42),
    })
    expect(read?.name).toBe("Your colours")
    expect(read?.stops.paper).toBe(hex(250, 250, 250))
  })
})

describe("palettes read from a logo", () => {
  it("keeps the readable ones, each colour pair once, at most six", () => {
    const palette = (name: string, primary: string) => ({
      name,
      paper: hex(250, 250, 250),
      tint: hex(230, 236, 242),
      primary,
      ink: hex(15, 27, 42),
    })
    const read = logoPalettesOf({
      palettes: [
        palette("Harbour blue", hex(30, 58, 95)),
        palette("Same again", hex(30, 58, 95)),
        { name: "Broken", paper: "not a colour" },
        ...Array.from({ length: 8 }, (_, i) =>
          palette(`Shade ${i}`, hex(20 + i * 10, 60, 40))
        ),
      ],
    })
    expect(read).toHaveLength(6)
    expect(read[0]?.name).toBe("Harbour blue")
    expect(read.map((p) => p.name)).not.toContain("Same again")
    expect(logoPalettesOf("nonsense")).toEqual([])
  })

  it("counts a palette as finished once the next begins or its ink is in, and all of them at the end", () => {
    const whole = (primary: string) => ({
      name: "Harbour blue",
      paper: hex(250, 250, 250),
      tint: hex(230, 236, 242),
      primary,
      ink: hex(15, 27, 42),
    })
    const first = whole(hex(30, 58, 95))
    const { ink: _, ...unfinished } = whole(hex(90, 20, 20))
    expect(finishedPalettes(null, false)).toEqual([])
    expect(finishedPalettes({ palettes: [{ name: "Har" }] }, false)).toEqual([])
    expect(finishedPalettes({ palettes: [unfinished] }, false)).toEqual([])
    expect(finishedPalettes({ palettes: [first] }, false)).toHaveLength(1)
    expect(
      finishedPalettes({ palettes: [first, unfinished] }, false)
    ).toHaveLength(1)
    expect(
      finishedPalettes({ palettes: [unfinished, first] }, false)
    ).toHaveLength(1)
    expect(
      finishedPalettes(
        { palettes: [first, { ...unfinished, ink: hex(1, 2, 3) }] },
        true
      )
    ).toHaveLength(2)
  })
})

describe("a photo review", () => {
  it("makes each photo's answer safe: a need of ours, a note when unusable, none read as unusable", () => {
    const looks = looksOf(
      {
        photos: [
          {
            index: 0,
            need: "hero",
            usable: true,
            alt: " A tidy kitchen ",
            note: "x",
          },
          { index: 1, need: "logo", usable: true, alt: "" },
          { index: 2, need: "work", usable: false, note: "Too dark" },
        ],
      },
      4
    )
    expect(looks[0]).toEqual({
      need: "hero",
      usable: true,
      alt: "A tidy kitchen",
      note: null,
    })
    expect(looks[1]?.need).toBeNull()
    expect(looks[2]).toMatchObject({ usable: false, note: "Too dark" })
    expect(looks[3]?.usable).toBe(false)
    expect(looks[3]?.note).toBeTruthy()
    expect(looksOf("nonsense", 1)[0]?.usable).toBe(false)
  })

  it("counts what is missing from every photo held, the optional need too", () => {
    const photo = (id: number, use?: Asset["use"]) =>
      ({
        id: `0000000${id}-0000-4000-8000-000000000000`,
        name: "p.jpg",
        content_type: "image/jpeg",
        bytes: 1,
        ...(use ? { use } : {}),
      }) as Asset
    expect(
      missingOf([
        photo(1, "hero"),
        photo(2, "work"),
        photo(3),
        photo(4, "logo"),
      ])
    ).toEqual([
      { need: "work", count: 2 },
      { need: "team", count: 1 },
    ])
  })
})

describe("POST /palettes/from-image", () => {
  const owner = { orgId: "org-a" } as Owner
  const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0,
  ])
  const markers = new Set<string>()
  const env = {
    SITES: {
      list: async ({ prefix }: { prefix: string }) => ({
        objects: [...markers]
          .filter((k) => k.startsWith(prefix))
          .map((key) => ({ key })),
      }),
      put: async (key: string) => {
        markers.add(key)
      },
    },
  } as unknown as Env
  const model = (answer: object) =>
    new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: JSON.stringify(answer) }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: {
            total: 900,
            noCache: 900,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 60, text: 60, reasoning: undefined },
        },
        warnings: [],
      }),
    })
  const send = (bytes: Uint8Array) => {
    const form = new FormData()
    form.append("file", new File([bytes], "van.png"))
    return new Request("https://api.test/palettes/from-image", {
      method: "POST",
      body: form,
    })
  }

  it("answers a readable palette with its name and stores no picture", async () => {
    const response = await paletteFromImage(
      send(PNG),
      env,
      ledger().kit,
      owner,
      {
        model: model({
          name: "Harbour blue",
          paper: hex(245, 247, 250),
          tint: hex(230, 236, 242),
          primary: hex(120, 170, 220),
          ink: hex(15, 27, 42),
        }),
      }
    )
    expect(response.status).toBe(200)
    const palette = PaletteFromImage.parse(await response.json())
    expect(palette.name).toBe("Harbour blue")
    expect(
      Math.max(
        contrast(rgb(palette.stops.primary), WHITE),
        contrast(rgb(palette.stops.primary), rgb(palette.stops.ink))
      )
    ).toBeGreaterThanOrEqual(4.5)
    expect(
      [...markers].every((k) => k.startsWith("vision-days/palette/org-a/"))
    ).toBe(true)
  })

  it("counts the call as spend, at its cost under what it reserved", async () => {
    const books = ledger()
    await paletteFromImage(send(PNG), env, books.kit, owner, {
      model: model({ name: "x" }),
    })
    expect(books.rows.map((r) => r.type)).toEqual([
      "cos.background_reserve",
      "cos.background_step",
    ])
    expect(books.rows[1]?.payload).toMatchObject({ job: "vision_palette" })
    const cost = Number(books.rows[1]?.payload.cost_usd)
    expect(cost).toBeGreaterThan(0)
    expect(cost).toBeLessThan(0.01)
  })

  it("reserves a call at the output cap it sets, the planner's when it sets none", () => {
    const price = { input: 0, output: 1_000_000, cacheRead: 0 }
    expect(worstCall(price, 0, 3_000)).toBe(3_000)
    expect(worstCall(price, 0)).toBe(PLANNER.maxOutputTokens)
  })

  it("answers 429 and calls no model once the day's cap has no room", async () => {
    const books = ledger(DAILY_CAP_USD)
    const asked = model({ name: "x" })
    const response = await paletteFromImage(send(PNG), env, books.kit, owner, {
      model: asked,
    })
    expect(response.status).toBe(429)
    expect(ErrorEnvelope.parse(await response.json()).code).toBe(
      "vision.daily_cap"
    )
    expect(asked.doGenerateCalls).toHaveLength(0)
    expect(books.rows).toHaveLength(0)
  })

  it("refuses what is not an image, and a palette with no colours in it", async () => {
    const svg = await paletteFromImage(
      send(new TextEncoder().encode("<svg/>")),
      env,
      ledger().kit,
      owner,
      {
        model: model({}),
      }
    )
    expect(svg.status).toBe(415)
    const empty = await paletteFromImage(send(PNG), env, ledger().kit, owner, {
      model: model({ name: "x" }),
    })
    expect(empty.status).toBe(422)
    expect(ErrorEnvelope.parse(await empty.json()).message).toContain(
      "Try another one"
    )
  })
})

describe("POST /palettes/from-logo", () => {
  const owner = { orgId: "org-a" } as Owner
  const logo = {
    id: "11111111-0000-4000-8000-000000000000",
    name: "Logo.png",
    content_type: "image/png",
    bytes: 9,
    use: "logo",
  } as Asset
  const key = `logo-palettes/org-a/${logo.id}.json`
  const books = (spent = 0) => {
    const { kit, rows } = ledger(spent)
    return {
      rows,
      kit: {
        withOrg: (at: unknown, run: unknown) =>
          run === readFacts
            ? [{ key: "media.uploads", value: { items: [logo] } }]
            : kit.withOrg(at as never, run as never),
      } as unknown as Tenancy,
    }
  }
  const sites = () => {
    const objects = new Map<string, string>([[`uploads/org-a/${logo.id}`, "x"]])
    return {
      objects,
      list: async ({ prefix }: { prefix: string }) => ({
        objects: [...objects.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => ({ key: k })),
      }),
      get: async (k: string) => {
        const body = objects.get(k)
        return body === undefined
          ? null
          : {
              body: new Response(body).body,
              json: async () => JSON.parse(body),
            }
      },
      put: async (k: string, body: string) => {
        objects.set(k, body)
      },
    }
  }
  const ask = (signal?: AbortSignal) =>
    new Request("https://api.test/palettes/from-logo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ asset_id: logo.id }),
      signal,
    })
  const palette = (name: string, primary: string) => ({
    name,
    paper: hex(250, 250, 250),
    tint: hex(230, 236, 242),
    primary,
    ink: hex(15, 27, 42),
  })
  const harbour = palette("Harbour blue", hex(30, 58, 95))
  const clay = palette("Warm clay", hex(160, 80, 50))

  /** A model that writes the answer a piece at a time, each when the test lets it. */
  const writing = () => {
    let controller!: ReadableStreamDefaultController<Record<string, unknown>>
    let begun: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      begun = resolve
    })
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream({
          start(c) {
            controller = c
            begun()
            c.enqueue({ type: "stream-start", warnings: [] })
            c.enqueue({ type: "text-start", id: "t" })
            abortSignal?.addEventListener("abort", () =>
              c.error(abortSignal.reason)
            )
          },
        }) as never,
      }),
    })
    return {
      model,
      started,
      write: (delta: string) =>
        controller.enqueue({ type: "text-delta", id: "t", delta }),
      end: () => {
        controller.enqueue({ type: "text-end", id: "t" })
        controller.enqueue({
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: {
              total: 900,
              noCache: 900,
              cacheRead: 0,
              cacheWrite: 0,
            },
            outputTokens: { total: 120, text: 120, reasoning: 0 },
          },
        })
        controller.close()
      },
    }
  }
  const lineReader = (response: Response) => {
    const reader = (response.body as ReadableStream<Uint8Array>)
      .pipeThrough(new TextDecoderStream())
      .getReader()
    let pending = ""
    return {
      next: async () => {
        while (!pending.includes("\n")) {
          const { done, value } = await reader.read()
          if (done) return null
          pending += value
        }
        const at = pending.indexOf("\n")
        const line = pending.slice(0, at)
        pending = pending.slice(at + 1)
        return PaletteFromImage.parse(JSON.parse(line))
      },
    }
  }
  const soon = () => new Promise((resolve) => setTimeout(resolve, 20))

  it("sends the first palette before the call ends, then the rest, and holds the list", async () => {
    const SITES = sites()
    const live = writing()
    const books_ = books()
    const pending = logoPalettes(
      ask(),
      { SITES } as unknown as Env,
      books_.kit,
      owner,
      () => undefined,
      { model: live.model }
    )
    await live.started
    live.write(`{"palettes": [${JSON.stringify(harbour)}, {"name": "Wa`)
    const response = await pending
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe(LOGO_PALETTES_LINES)
    const read = lineReader(response)
    expect((await read.next())?.name).toBe("Harbour blue")
    expect(SITES.objects.has(key)).toBe(false)

    live.write(
      `rm clay", "paper": "${clay.paper}", "tint": "${clay.tint}", "primary": "${clay.primary}", "ink": "${clay.ink}"}`
    )
    expect((await read.next())?.name).toBe("Warm clay")
    live.write(`, ${JSON.stringify({ ...clay, name: "Clay again" })}]}`)
    live.end()
    expect(await read.next()).toBeNull()
    expect(
      LogoPalettes.parse(
        JSON.parse(SITES.objects.get(key) as string)
      ).palettes.map((p) => p.name)
    ).toEqual(["Harbour blue", "Warm clay"])
    expect(books_.rows.map((r) => r.type)).toEqual([
      "cos.background_reserve",
      "cos.background_step",
    ])
  })

  it("holds and costs the palettes after the response has gone, then serves the next from what was held", async () => {
    const SITES = sites()
    const live = writing()
    const books_ = books()
    // As the worker does: the kit closes once the work the route registered settles.
    let closed = false
    const kit = {
      withOrg: (at: unknown, run: unknown) => {
        if (closed) throw new Error("CONNECTION_ENDED")
        return books_.kit.withOrg(at as never, run as never)
      },
    } as unknown as Tenancy
    const running: Promise<unknown>[] = []
    const pending = logoPalettes(
      ask(),
      { SITES } as unknown as Env,
      kit,
      owner,
      (promise) => running.push(promise),
      { model: live.model }
    )
    await live.started
    live.write(`{"palettes": [${JSON.stringify(harbour)}, `)
    const response = await pending
    const settled = Promise.allSettled(running).then(() => {
      closed = true
    })
    live.write(`${JSON.stringify(clay)}]}`)
    live.end()
    expect((await response.text()).trim().split("\n")).toHaveLength(2)
    await settled
    expect(SITES.objects.has(key)).toBe(true)
    expect(books_.rows.map((r) => r.type)).toEqual([
      "cos.background_reserve",
      "cos.background_step",
    ])

    const again = writing()
    const served = await logoPalettes(
      ask(),
      { SITES } as unknown as Env,
      books().kit,
      owner,
      () => undefined,
      { model: again.model }
    )
    expect((await served.text()).trim().split("\n")).toHaveLength(2)
    expect(again.model.doStreamCalls).toHaveLength(0)
  })

  it("serves what was held a palette a line, with no call", async () => {
    const SITES = sites()
    const live = writing()
    const palettes = [harbour, clay].map((p) =>
      PaletteFromImage.parse({
        name: p.name,
        stops: { paper: p.paper, tint: p.tint, primary: p.primary, ink: p.ink },
      })
    )
    SITES.objects.set(key, JSON.stringify({ palettes }))
    const response = await logoPalettes(
      ask(),
      { SITES } as unknown as Env,
      books().kit,
      owner,
      () => undefined,
      { model: live.model }
    )
    expect(response.headers.get("content-type")).toBe(LOGO_PALETTES_LINES)
    expect((await response.text()).trim().split("\n")).toEqual(
      palettes.map((p) => JSON.stringify(p))
    )
    expect(live.model.doStreamCalls).toHaveLength(0)
  })

  it("answers 422 when the call ends with no readable palette, and holds nothing", async () => {
    const SITES = sites()
    const live = writing()
    const pending = logoPalettes(
      ask(),
      { SITES } as unknown as Env,
      books().kit,
      owner,
      () => undefined,
      { model: live.model }
    )
    await live.started
    live.write(`{"palettes": [{"name": "x"}]}`)
    live.end()
    const response = await pending
    expect(response.status).toBe(422)
    expect(ErrorEnvelope.parse(await response.json()).code).toBe(
      "palette.unreadable"
    )
    expect(SITES.objects.has(key)).toBe(false)
  })

  it("answers 429 and calls no model once the day's cap has no room", async () => {
    const live = writing()
    const response = await logoPalettes(
      ask(),
      { SITES: sites() } as unknown as Env,
      books(DAILY_CAP_USD).kit,
      owner,
      () => undefined,
      { model: live.model }
    )
    expect(response.status).toBe(429)
    expect(live.model.doStreamCalls).toHaveLength(0)
  })

  it("stops the call when the owner leaves, and holds nothing", async () => {
    const SITES = sites()
    const live = writing()
    const gone = new AbortController()
    const pending = logoPalettes(
      ask(gone.signal),
      { SITES } as unknown as Env,
      books().kit,
      owner,
      () => undefined,
      { model: live.model }
    )
    await live.started
    live.write(`{"palettes": [${JSON.stringify(harbour)}, {"na`)
    const response = await pending
    const read = lineReader(response)
    await read.next()
    gone.abort()
    await soon()
    expect(live.model.doStreamCalls[0]?.abortSignal?.aborted).toBe(true)
    expect(SITES.objects.has(key)).toBe(false)
  })

  it("refuses a logo that is not the one held now", async () => {
    const response = await logoPalettes(
      new Request("https://api.test/palettes/from-logo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          asset_id: "22222222-0000-4000-8000-000000000000",
        }),
      }),
      { SITES: sites() } as unknown as Env,
      books().kit,
      owner,
      () => undefined,
      { model: null }
    )
    expect(response.status).toBe(400)
  })
})
