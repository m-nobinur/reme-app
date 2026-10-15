import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { PALETTES } from "@workspace/contracts"
import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { initialOf, markColours, markSvg } from "../src/favicon"
import { type Built, build, clean, readPages } from "./build"
import { FILLED } from "./fixture"

const palette = PALETTES[0] as (typeof PALETTES)[number]

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

  test("reads its colours from the palette, then the brand colour", () => {
    const roles = ["paper", "ink", "primary", "tint", "accent", "line"] as const
    expect(
      markColours(roles.map((role) => `${role}:${palette[role]}`).join(" "), "")
    ).toEqual({ primary: palette.primary, paper: palette.paper })
    expect(markColours("", palette.primary).primary).toMatch(/^#[0-9a-f]{6}$/i)
    expect(markColours("", "").primary).toMatch(/^#[0-9a-f]{6}$/i)
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
  beforeAll(async () => {
    ;[initial, logoed] = await Promise.all([
      build({ site: { ...FILLED, logo: "", logoAlt: "" } }),
      build({
        site: { ...FILLED, logo: "/uploads/logo.png", logoAlt: "BrightClean" },
        files: { "src/assets/uploads/logo.png": await logo() },
      }),
    ])
  }, 180_000)
  afterAll(() => {
    clean(initial)
    clean(logoed)
  })

  test("writes the SVG, the PNGs at their sizes and the manifest", async () => {
    const dist = initial.dist
    expect(readFileSync(join(dist, "favicon.svg"), "utf8")).toMatch(
      /^<svg [\s\S]*<path /
    )
    for (const [file, size] of [
      ["favicon-32.png", 32],
      ["apple-touch-icon.png", 180],
      ["icon-192.png", 192],
      ["icon-512.png", 512],
    ] as const) {
      const meta = await sharp(join(dist, file)).metadata()
      expect([file, meta.format, meta.width, meta.height]).toEqual([
        file,
        "png",
        size,
        size,
      ])
    }
    // The home-screen icon is opaque: iOS draws a transparent corner black.
    expect(
      (await sharp(join(dist, "apple-touch-icon.png")).stats()).isOpaque
    ).toBe(true)
    const manifest = JSON.parse(
      readFileSync(join(dist, "site.webmanifest"), "utf8")
    )
    expect(manifest).toMatchObject({
      name: "BrightClean",
      theme_color: expect.stringMatching(/^#/),
      icons: expect.arrayContaining([
        expect.objectContaining({ src: "/icon-192.png", sizes: "192x192" }),
        expect.objectContaining({ src: "/icon-512.png", sizes: "512x512" }),
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
          "icon /favicon-32.png",
          "icon /favicon.svg",
          "apple-touch-icon /apple-touch-icon.png",
          "manifest /site.webmanifest",
        ])
      )
      expect(
        page.elements.some(
          (e) => e.tag === "meta" && e.attrs.name === "theme-color"
        ),
        page.file
      ).toBe(true)
      for (const href of ["favicon.svg", "favicon-32.png", "site.webmanifest"])
        expect(existsSync(join(initial.dist, href))).toBe(true)
    }
  })

  test("draws the owner's logo in place of the initial", async () => {
    const svg = readFileSync(join(logoed.dist, "favicon.svg"), "utf8")
    expect(svg).toContain("<image")
    expect(svg).toContain("data:image/png;base64,")
    // The logo's red reaches the PNG.
    const { dominant } = await sharp(join(logoed.dist, "icon-192.png")).stats()
    expect(dominant.r).toBeGreaterThan(dominant.g)
  })
})
