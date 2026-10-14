import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { CROPS_MAX, cropKey, SHOTS_SCRIPT } from "../src/shots.ts"

type Shot = {
  path: string
  fullPage?: boolean
  clip?: { y: number; height: number; width: number }
}

// The script is plain ESM that the sandbox runs; the test loads that same text.
const load = async () => {
  const file = join(mkdtempSync(join(tmpdir(), "shots-")), "shots.mjs")
  writeFileSync(file, SHOTS_SCRIPT)
  return (await import(pathToFileURL(file).href)) as {
    shoot: (
      browser: unknown,
      url: string,
      dir: string,
      cropMax: number
    ) => Promise<boolean>
    HEIGHT: number
    inPage: () => Promise<void>
  }
}

/** A browser whose home page is `heights[width]` px tall; records every screenshot and the page's loading step. */
const browserOf = (heights: Record<number, number>) => {
  const shots: Shot[] = []
  const order: string[] = []
  /** The motion preference each width's page was opened with. */
  const motion: (string | undefined)[] = []
  return {
    shots,
    motion,
    order,
    browser: {
      newContext: async ({
        viewport,
        reducedMotion,
      }: {
        viewport: { width: number }
        reducedMotion?: string
      }) => ({
        newPage: async () => ({
          goto: async () => {
            motion.push(reducedMotion)
          },
          evaluate: async (fn: { name: string }) => {
            if (fn.name === "inPage") {
              order.push("load")
              return undefined
            }
            return heights[viewport.width]
          },
          screenshot: async (shot: Shot) => {
            order.push("shot")
            shots.push(shot)
          },
        }),
        close: async () => undefined,
      }),
    },
  }
}

describe("the capture script", () => {
  it("keeps a whole-page image for the card and cuts the critic's pieces one screen tall", async () => {
    const { shoot, HEIGHT } = await load()
    const { browser, shots } = browserOf({ 390: 2000, 768: 900, 1440: 1000 })
    expect(await shoot(browser, "http://x/", "/tmp", CROPS_MAX)).toBe(true)
    expect(shots.map((s) => s.path.replace("/tmp/", ""))).toEqual([
      "home-390.png",
      "crop-390-1.png",
      "crop-390-2.png",
      "crop-390-3.png",
      "home-768.png",
      "crop-768-1.png",
      "home-1440.png",
      "crop-1440-1.png",
      "crop-1440-2.png",
    ])
    const crops = shots.filter((s) => s.clip)
    // No piece is taller than a screen, and the last one stops at the page's end.
    expect(crops.every((s) => (s.clip?.height ?? 0) <= HEIGHT)).toBe(true)
    expect(crops.slice(0, 3).map((s) => [s.clip?.y, s.clip?.height])).toEqual([
      [0, 900],
      [900, 900],
      [1800, 200],
    ])
  })

  it("stops at the cap on a very long page", async () => {
    const { shoot } = await load()
    const { browser, shots } = browserOf({ 390: 9974, 768: 8247, 1440: 7403 })
    await shoot(browser, "http://x/", "/tmp", CROPS_MAX)
    const per = (w: number) =>
      shots.filter((s) => s.path.includes(`crop-${w}-`)).length
    expect([per(390), per(768), per(1440)]).toEqual([
      CROPS_MAX,
      CROPS_MAX,
      CROPS_MAX,
    ])
  })

  it("goes on to the next width when one fails, and says so", async () => {
    const { shoot } = await load()
    const { browser, shots } = browserOf({ 768: 900, 1440: 900 })
    const broken = {
      newContext: async (o: { viewport: { width: number } }) => {
        if (o.viewport.width === 390) throw new Error("crashed")
        return browser.newContext(o)
      },
    }
    expect(await shoot(broken, "http://x/", "/tmp", CROPS_MAX)).toBe(false)
    expect(shots.some((s) => s.path.includes("home-1440"))).toBe(true)
  })
})

describe("motion in a capture", () => {
  it("opens every width with reduced motion, so no reveal is caught mid-fade", async () => {
    const { shoot } = await load()
    const { browser, motion } = browserOf({ 390: 900, 768: 900, 1440: 900 })
    await shoot(browser, "http://x/", "/tmp", CROPS_MAX)
    expect(motion).toEqual(["reduce", "reduce", "reduce"])
  })

  it("waits for clock-driven animations, and not for a scroll timeline", async () => {
    const { inPage } = await load()
    const finished: string[] = []
    const animation = (
      name: string,
      timeline: unknown,
      iterations: number
    ) => ({
      timeline,
      effect: { getComputedTiming: () => ({ iterations }) },
      get finished() {
        finished.push(name)
        return Promise.resolve()
      },
    })
    class DocumentTimeline {}
    const clock = new DocumentTimeline()
    const g = globalThis as Record<string, unknown>
    const before = {
      document: g.document,
      window: g.window,
      tl: g.DocumentTimeline,
    }
    g.DocumentTimeline = DocumentTimeline
    g.document = {
      images: [],
      documentElement: { scrollHeight: 100 },
      getAnimations: () => [
        animation("fade", clock, 1),
        animation("spin", clock, Number.POSITIVE_INFINITY),
        animation("reveal", {}, 1),
      ],
    }
    g.window = { innerHeight: 900, scrollTo: () => undefined }
    try {
      await inPage()
    } finally {
      g.document = before.document
      g.window = before.window
      g.DocumentTimeline = before.tl
    }
    expect(finished).toEqual(["fade"])
  })
})

describe("lazy images in a capture", () => {
  it("loads the page's images before the first shot at every width", async () => {
    const { shoot } = await load()
    const { browser, order } = browserOf({ 390: 900, 768: 900, 1440: 900 })
    await shoot(browser, "http://x/", "/tmp", CROPS_MAX)
    // Per width: load, whole page, one piece.
    expect(order).toEqual([...Array(3).fill(["load", "shot", "shot"]).flat()])
  })

  it("makes every image eager, scrolls the whole page and waits for the decodes", async () => {
    const { inPage } = await load()
    const scrolled: number[] = []
    const image = () => {
      const img = {
        loading: "lazy",
        decoded: false,
        decode: async () => {
          img.decoded = true
        },
      }
      return img
    }
    const images = [image(), image()]
    const g = globalThis as Record<string, unknown>
    const before = { document: g.document, window: g.window }
    g.document = {
      images,
      documentElement: { scrollHeight: 2000 },
      getAnimations: () => [],
    }
    g.window = {
      innerHeight: 900,
      scrollTo: (_x: number, y: number) => scrolled.push(y),
    }
    try {
      await inPage()
    } finally {
      g.document = before.document
      g.window = before.window
    }
    expect(images.map((i) => i.loading)).toEqual(["eager", "eager"])
    expect(images.every((i) => i.decoded)).toBe(true)
    // Through the page in screen steps, then back to the top.
    expect(scrolled).toEqual([0, 900, 1800, 0])
  })
})

describe("cropKey", () => {
  it("sits outside screenshots/, which the router serves", () => {
    expect(cropKey("o", "r", 390, 2)).toBe("sites/o/r/critic/home-390-2.png")
  })
})
