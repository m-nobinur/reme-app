import { readdirSync } from "node:fs"
import { join } from "node:path"
import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { type Built, build, clean, readPages } from "./build"
import { FILLED } from "./fixture"

/** The hero a real build drew: a 3:4 PNG, 1152 px wide, in a split_arch hero. */
async function generated(): Promise<Uint8Array> {
  const [w, h] = [1152, 1536]
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
    // Every emitted image is one a page names.
    const html = home()?.html ?? ""
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
    expect(widths("image/avif")).toEqual(["480w", "768w", "1152w"])
    expect(widths("image/webp")).toEqual(["480w", "768w", "1152w"])
  })

  test("tells the browser the box the arch hero renders in, not 1280 px", () => {
    const sizes = (home()?.elements ?? [])
      .map((e) => e.attrs.sizes ?? e.attrs.imagesizes)
      .filter(Boolean)
    expect(sizes.length).toBeGreaterThan(0)
    for (const s of sizes) {
      expect(s).not.toContain("1280px")
      expect(s).toContain("30rem")
    }
  })
})
