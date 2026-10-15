import { readdirSync } from "node:fs"
import { join } from "node:path"
import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { type Built, build, clean, readPages } from "./build"
import { FILLED } from "./fixture"

/** The hero a real build drew: a 3:4 PNG, 1152 px wide, in a split_arch hero. */
async function generated(w = 1152, h = 1536): Promise<Uint8Array> {
  const raw = Buffer.alloc(w * h * 3)
  let state = 7
  for (let i = 0; i < raw.length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0 // the same grain every run
    raw[i] = state >>> 24
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toBuffer()
}

let built: Built
beforeAll(async () => {
  built = await build({
    standIns: false,
    site: {
      ...FILLED,
      logo: "",
      direction: "warm_editorial",
      heroImage: "src/assets/generated/home_hero_room.png",
    },
    files: { "src/assets/generated/home_hero_room.png": await generated() },
  })
}, 180_000)
afterAll(() => clean(built))

const home = () => readPages(built.dist).find((p) => p.file === "index.html")
const emitted = () => readdirSync(join(built.dist, "_astro")).sort()

describe("a generated photo", () => {
  test("ships only its resized variants, never the original", () => {
    expect(emitted().filter((f) => f.endsWith(".png"))).toEqual([])
    // Every emitted image is one a page names: the home hero, and the about
    // story, which shows the hero's photo when the gallery has none.
    const html = readPages(built.dist)
      .map((p) => p.html)
      .join("\n")
    for (const f of emitted().filter((name) => /\.(avif|webp)$/.test(name))) {
      expect(html, f).toContain(f)
    }
  })

  test("offers its own width when it is under the largest asked for", () => {
    const widths = (type: string) =>
      (
        home()?.elements.find(
          (e) => e.tag === "source" && e.attrs.type === type
        )?.attrs.srcset ?? ""
      )
        .split(",")
        .map((c) => c.trim().split(/\s+/)[1])
    expect(widths("image/avif")).toEqual(["640w", "960w", "1152w"])
    expect(widths("image/webp")).toEqual(["640w", "960w", "1152w"])
  })

  test("tells the browser the box the arch hero renders in, not 1280 px", () => {
    const sizes = (home()?.elements ?? [])
      .filter((e) => e.tag !== "link" || e.attrs.rel === "preload")
      .map((e) => e.attrs.sizes ?? e.attrs.imagesizes)
      .filter(Boolean)
    expect(sizes.length).toBeGreaterThan(0)
    for (const s of sizes) {
      expect(s).not.toContain("1280px")
      expect(s).toContain("30rem")
    }
  })
})

// A 1536 px hero at 1512 css px and 2x asks for its own width. The Developer
// once trimmed Photo.astro to pass the size gate and left it the 768 px one.
test("a 1536 px full-bleed hero offers 1280 and its own 1536 width", async () => {
  const wide = await build({
    site: {
      ...FILLED,
      logo: "",
      heroImage: "src/assets/generated/home_hero_garden.png",
    },
    files: {
      "src/assets/generated/home_hero_garden.png": await generated(1536, 864),
    },
  })
  try {
    const hero = readPages(wide.dist)
      .find((p) => p.file === "index.html")
      ?.elements.find(
        (e) => e.tag === "source" && e.attrs.type === "image/avif"
      )
    expect(
      (hero?.attrs.srcset ?? "").split(",").map((c) => c.trim().split(/\s+/)[1])
    ).toEqual(["640w", "960w", "1280w", "1536w"])
  } finally {
    clean(wide)
  }
}, 180_000)
