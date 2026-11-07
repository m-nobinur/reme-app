import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { PALETTES } from "@workspace/contracts"
import sharp from "sharp"
import { beforeAll, describe, expect, test } from "vitest"
import {
  initialOf,
  MARK_FILE,
  markColours,
  markSvg,
  siteMark,
  symbolOf,
} from "../src/favicon"
import { type Built, build, readPages } from "./build"
import { FILLED } from "./fixture"

const palette = PALETTES[0] as (typeof PALETTES)[number]

/** The path a built icon is served at, `/_astro/<name>.<hash>.<ext>`, or undefined when there is none. */
const iconPath = (dist: string, name: string, ext: string) => {
  const file = readdirSync(join(dist, "_astro")).find((f) =>
    new RegExp(`^${name}\\.[0-9a-f]{8}\\.${ext}$`).test(f)
  )
  return file && `/_astro/${file}`
}

describe("the mark", () => {
  test("takes the first letter or figure of the name", () => {
    expect(initialOf("BrightClean")).toBe("B")
    expect(initialOf("  élan cleaning")).toBe("E")
    expect(initialOf("24/7 Locksmiths")).toBe("2")
    expect(initialOf("")).toBe("")
  })

  test("draws the initial in the primary on the paper", () => {
    const colours = { primary: palette.primary, paper: palette.paper }
    const svg = markSvg("Neat", colours)
    expect(svg).toContain(`fill="${palette.paper}"`)
    expect(svg).toContain(`<path fill="${palette.primary}"`)
    expect(svg).toMatch(/<path [^>]* d="M/)
    expect(svg).not.toContain("<text")
    // A name with nothing to draw still gets a mark, never an empty tile.
    expect(markSvg("", colours)).toContain("<circle")
    expect(markSvg("Neat", colours, "data:image/png;base64,AA")).toContain(
      "<image"
    )
  })

  test("reads no logo from outside src/assets", async () => {
    // The tests run in the package root, where ../../package.json from
    // src/assets is a real file the mark must not read.
    for (const logo of ["../../package.json", "/../../package.json"]) {
      const svg = await siteMark({
        businessName: "Neat",
        palette: "",
        brandColor: "",
        logo,
      })
      expect(svg, logo).not.toContain("<image")
      expect(svg, logo).toContain("<path")
    }
  })

  test("reads its colours from the palette, then the brand colour", () => {
    const roles = ["paper", "ink", "primary", "tint", "accent", "line"] as const
    expect(
      markColours(roles.map((role) => `${role}:${palette[role]}`).join(" "), "")
    ).toEqual({ primary: palette.primary, paper: palette.paper })
    expect(markColours("", palette.primary).primary).toMatch(/^#[0-9a-f]{6}$/i)
    expect(markColours("", "").primary).toMatch(/^#[0-9a-f]{6}$/i)
  })
})

type Colour = { r: number; g: number; b: number }
const BLUE = { r: 0, g: 0, b: 255 }
const RED = { r: 255, g: 0, b: 0 }
const WHITE = { r: 255, g: 255, b: 255 }
const BLACK = { r: 0, g: 0, b: 0 }
const GREEN = { r: 20, g: 160, b: 40 }
type Rect = [x: number, y: number, w: number, h: number, colour: Colour]

/** A logo of `rects` on `background`, transparent when there is none. */
const picture = (
  w: number,
  h: number,
  background: Colour | null,
  rects: Rect[]
) =>
  sharp({
    create: {
      width: w,
      height: h,
      channels: 4,
      background: background ?? { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(
      rects.map(([x, y, rw, rh, colour]) => ({
        input: {
          create: { width: rw, height: rh, channels: 3, background: colour },
        },
        left: x,
        top: y,
      }))
    )
    .png()
    .toBuffer()

/** The pixels of a data URI's PNG, or undefined when there is none. */
const pixels = async (uri: string | undefined) => {
  if (!uri) return undefined
  const { data, info } = await sharp(
    Buffer.from(uri.split(",")[1] ?? "", "base64")
  )
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return {
    at: (x: number, y: number) => [
      ...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4),
    ],
    all: Array.from({ length: info.width * info.height }, (_, i) => [
      ...data.subarray(i * 4, i * 4 + 4),
    ]),
  }
}

describe("the symbol cut from a logo", () => {
  test("is the block beside a wide bar, without the bar", async () => {
    const uri = await symbolOf(
      await picture(600, 200, null, [
        [20, 20, 160, 160, BLUE],
        [260, 80, 300, 40, RED],
      ])
    )
    const seen = (await pixels(uri))?.all.filter((p) => p[3] === 255)
    expect(seen?.length).toBeGreaterThan(0)
    expect(seen?.every((p) => p[2] === 255 && p[0] === 0)).toBe(true)
  })

  test("is the whole logo when it is all symbol, as sparkles over a bucket", async () => {
    const seen = await pixels(
      await symbolOf(
        await picture(300, 400, null, [
          [110, 20, 80, 80, RED],
          [40, 120, 220, 260, BLUE],
        ])
      )
    )
    const solid = seen?.all.filter((p) => p[3] === 255) ?? []
    expect(solid.some((p) => p[0] === 255 && p[2] === 0)).toBe(true)
    expect(solid.some((p) => p[2] === 255 && p[0] === 0)).toBe(true)
  })

  test("is nothing for a wide bar alone", async () => {
    expect(
      await symbolOf(await picture(400, 100, null, [[0, 20, 400, 60, RED]]))
    ).toBeUndefined()
  })

  test("is nothing when a wide piece holds most of the ink", async () => {
    expect(
      await symbolOf(
        await picture(600, 200, null, [
          [20, 80, 40, 40, BLUE],
          [160, 70, 400, 60, RED],
        ])
      )
    ).toBeUndefined()
  })

  test("leaves the background of an opaque logo transparent but keeps white inside the drawing", async () => {
    const cut = await pixels(
      await symbolOf(
        await picture(600, 200, WHITE, [
          [20, 20, 160, 160, BLUE],
          [50, 50, 100, 100, WHITE],
          [260, 80, 300, 40, RED],
        ])
      )
    )
    expect(cut?.at(0, 0)?.[3]).toBe(0)
    expect(cut?.at(255, 255)?.[3]).toBe(0)
    expect(cut?.at(128, 128)).toEqual([255, 255, 255, 255])
  })

  test("keeps an opaque framed picture whole, white inside and all", async () => {
    const framed = await picture(300, 300, WHITE, [
      [20, 20, 260, 260, BLACK],
      [30, 30, 240, 240, WHITE],
      [100, 100, 100, 100, BLACK],
    ])
    const uri = await symbolOf(framed)
    const today = await sharp(framed)
      .resize(128, 128, { fit: "inside" })
      .png()
      .toBuffer()
    expect(uri).toBe(`data:image/png;base64,${today.toString("base64")}`)
    expect((await pixels(uri))?.at(20, 20)).toEqual([255, 255, 255, 255])
  })
})

/** A small square logo, so the build has one to draw. */
const logo = () =>
  sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: { r: 200, g: 40, b: 40 },
    },
  })
    .png()
    .toBuffer()

describe("a built site's favicon set", () => {
  let initial: Built
  let logoed: Built
  let marked: Built
  beforeAll(async () => {
    const withLogo = {
      site: { ...FILLED, logo: "/uploads/logo.png", logoAlt: "BrightClean" },
    }
    ;[initial, logoed, marked] = await Promise.all([
      build({ site: { ...FILLED, logo: "", logoAlt: "" } }),
      build({
        ...withLogo,
        files: { "src/assets/uploads/logo.png": await logo() },
      }),
      build({
        ...withLogo,
        files: {
          "src/assets/uploads/logo.png": await logo(),
          [MARK_FILE]: await picture(64, 64, GREEN, []),
        },
      }),
    ])
  }, 180_000)
  test("writes the SVG, the PNGs at their sizes and the manifest", async () => {
    const dist = initial.dist
    expect(
      readFileSync(join(dist, iconPath(dist, "favicon", "svg") ?? ""), "utf8")
    ).toMatch(/^<svg [\s\S]*<path /)
    for (const [name, size] of [
      ["favicon-32", 32],
      ["apple-touch-icon", 180],
      ["icon-192", 192],
      ["icon-512", 512],
    ] as const) {
      const meta = await sharp(
        join(dist, iconPath(dist, name, "png") ?? "")
      ).metadata()
      expect([name, meta.format, meta.width, meta.height]).toEqual([
        name,
        "png",
        size,
        size,
      ])
    }
    // The home-screen icon is opaque: iOS draws a transparent corner black.
    expect(
      (
        await sharp(
          join(dist, iconPath(dist, "apple-touch-icon", "png") ?? "")
        ).stats()
      ).isOpaque
    ).toBe(true)
    const manifest = JSON.parse(
      readFileSync(join(dist, "site.webmanifest"), "utf8")
    )
    expect(manifest).toMatchObject({
      name: "BrightClean",
      theme_color: expect.stringMatching(/^#/),
      icons: expect.arrayContaining([
        expect.objectContaining({
          src: iconPath(dist, "icon-192", "png"),
          sizes: "192x192",
        }),
        expect.objectContaining({
          src: iconPath(dist, "icon-512", "png"),
          sizes: "512x512",
        }),
      ]),
    })
    // Pages only: an icon is never a route in the sitemap.
    expect(readFileSync(join(dist, "sitemap.xml"), "utf8")).not.toMatch(
      /favicon|icon-|webmanifest/
    )
  })

  test("every page links them in its head", () => {
    for (const page of readPages(initial.dist)) {
      const links = page.elements
        .filter((e) => e.tag === "link")
        .map((e) => `${e.attrs.rel} ${e.attrs.href}`)
      expect(links, page.file).toEqual(
        expect.arrayContaining([
          `icon ${iconPath(initial.dist, "favicon-32", "png")}`,
          `icon ${iconPath(initial.dist, "favicon", "svg")}`,
          `apple-touch-icon ${iconPath(initial.dist, "apple-touch-icon", "png")}`,
          "manifest /site.webmanifest",
        ])
      )
      expect(
        page.elements.some(
          (e) => e.tag === "meta" && e.attrs.name === "theme-color"
        ),
        page.file
      ).toBe(true)
    }
  })

  test("draws the owner's logo in place of the initial", async () => {
    const svg = readFileSync(
      join(logoed.dist, iconPath(logoed.dist, "favicon", "svg") ?? ""),
      "utf8"
    )
    expect(svg).toContain("<image")
    expect(svg).toContain("data:image/png;base64,")
    // The logo's red reaches the PNG.
    const { dominant } = await sharp(
      join(logoed.dist, iconPath(logoed.dist, "icon-192", "png") ?? "")
    ).stats()
    expect(dominant.r).toBeGreaterThan(dominant.g)
  })

  test("draws the logo's placed mark in place of the logo", async () => {
    const svg = readFileSync(
      join(marked.dist, iconPath(marked.dist, "favicon", "svg") ?? ""),
      "utf8"
    )
    expect(svg).toContain("<image")
    const { dominant } = await sharp(
      join(marked.dist, iconPath(marked.dist, "icon-192", "png") ?? "")
    ).stats()
    expect(dominant.g).toBeGreaterThan(dominant.r)
  })
})
