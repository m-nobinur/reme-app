import { statSync } from "node:fs"
import { join } from "node:path"
import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { type Built, build, clean, readPages } from "./build"
import { FILLED } from "./fixture"

/** IG3's budget: the hero at 1280 px, any other image, and the phone's home page. */
const HERO = 180 * 1024
const OTHER = 90 * 1024
const HOME = 700 * 1024
/** A phone: 390 css px at 2x asks for a 780 px candidate. */
const PHONE = 390 * 2

/**
 * A soft, grained 2400 x 1600 frame: the weight of a real photo is owed to the
 * final pass. `detail` is the width of the noise it is scaled up from: 120 is
 * a card, 480 a lawn or a tiled floor, whose 1280 px AVIF was 341 KiB at the
 * hero's old quality 75 (366 KiB here) against the 180 KiB line.
 */
async function photo(seed: number, detail = 120): Promise<Uint8Array> {
  const [w, h] = [2400, 1600]
  const low = await sharp({
    create: {
      width: detail,
      height: detail * (2 / 3),
      channels: 3,
      background: { r: 120 + seed * 20, g: 130, b: 140 },
      noise: { type: "gaussian", mean: 128, sigma: 40 },
    },
  })
    .resize(w, h, { kernel: "cubic" })
    .raw()
    .toBuffer()
  let state = seed + 1
  for (let i = 0; i < low.length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0 // a small LCG: the same grain every run
    low[i] = Math.max(0, Math.min(255, low[i] + ((state >>> 24) % 9) - 4))
  }
  return sharp(low, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 85 })
    .toBuffer()
}

let built: Built
beforeAll(async () => {
  const [hero, one, two, three] = await Promise.all(
    [1, 2, 3, 4].map((seed) => photo(seed, seed === 1 ? 480 : 120))
  )
  built = await build({
    site: {
      ...FILLED,
      logo: "",
      heroImage: "/uploads/hero.jpg",
      photo1Src: "/uploads/one.jpg",
      photo2Src: "/uploads/two.jpg",
      photo3Src: "/uploads/three.jpg",
    },
    files: {
      "src/assets/uploads/hero.jpg": hero,
      "src/assets/uploads/one.jpg": one,
      "src/assets/uploads/two.jpg": two,
      "src/assets/uploads/three.jpg": three,
    },
  })
}, 180_000)
afterAll(() => clean(built))

type Tag = { tag: string; attrs: Record<string, string> }
const home = () => readPages(built.dist).find((p) => p.file === "index.html")
const tags = (): Tag[] => home()?.elements ?? []

/** The AVIF candidate a phone downloads for each picture, with the img that follows it. */
function phoneImages() {
  const out: { img: Tag; bytes: number; url: string; width: number }[] = []
  const all = tags()
  all.forEach((el, i) => {
    if (el.tag !== "source" || el.attrs.type !== "image/avif") return
    const img = all.slice(i).find((e) => e.tag === "img")
    const candidates = (el.attrs.srcset ?? "").split(",").map((c) => {
      const [url, w] = c.trim().split(/\s+/)
      return { url, width: Number.parseInt(w ?? "", 10) }
    })
    const pick =
      candidates.find((c) => c.width >= PHONE) ??
      candidates[candidates.length - 1]
    if (!img || !pick?.url) throw new Error("a picture has no candidate")
    out.push({
      img,
      ...pick,
      bytes: statSync(join(built.dist, pick.url)).size,
    } as never)
  })
  return out
}

describe("uploaded photos", () => {
  test("go out as AVIF and WebP up to the source width, the hero from 640 to 2560, with width and height", () => {
    const hero = tags().find((e) =>
      (e.attrs.class ?? "").includes("hero-image")
    )
    expect(hero?.attrs.width).toBeTruthy()
    expect(hero?.attrs.height).toBeTruthy()
    for (const type of ["image/avif", "image/webp"]) {
      const source = tags().find(
        (e) => e.tag === "source" && e.attrs.type === type
      )
      const widths = (source?.attrs.srcset ?? "")
        .split(",")
        .map((c) => c.trim().split(/\s+/)[1])
      expect(widths, type).toEqual(["640w", "960w", "1280w", "1920w", "2400w"])
    }
  })

  test("preload and prioritise the hero only; everything else is lazy", () => {
    const preloads = tags().filter(
      (e) =>
        e.tag === "link" && e.attrs.rel === "preload" && e.attrs.as === "image"
    )
    expect(preloads).toHaveLength(1)
    expect(preloads[0]?.attrs.fetchpriority).toBe("high")
    expect(preloads[0]?.attrs.imagesrcset).toContain("640w")
    const imgs = tags().filter((e) => e.tag === "img")
    const hero = imgs.filter((e) => e.attrs.fetchpriority === "high")
    expect(hero).toHaveLength(1)
    expect(hero[0]?.attrs.loading).toBe("eager")
    for (const img of imgs.filter((e) => e !== hero[0])) {
      expect(img.attrs.loading, img.attrs.src).toBe("lazy")
    }
  })
})

describe("the image budget", () => {
  test("the hero at 1280 is at most 180 KB", () => {
    const hero = tags().find(
      (e) => e.tag === "source" && e.attrs.type === "image/avif"
    )
    const url = (hero?.attrs.srcset ?? "")
      .split(",")
      .map((c) => c.trim().split(/\s+/))
      .find(([, w]) => w === "1280w")?.[0]
    expect(statSync(join(built.dist, url ?? "")).size).toBeLessThanOrEqual(HERO)
  })

  test("any other image is at most 90 KB, and the home page's images 700 KB, on a phone", () => {
    const images = phoneImages()
    expect(images.length).toBeGreaterThan(1)
    const others = images.filter((i) => i.img.attrs.fetchpriority !== "high")
    for (const i of others) expect(i.bytes, i.url).toBeLessThanOrEqual(OTHER)
    expect(images.reduce((sum, i) => sum + i.bytes, 0)).toBeLessThanOrEqual(
      HOME
    )
  })
})
