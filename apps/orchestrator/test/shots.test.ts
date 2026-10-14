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
  }
}

/** A browser whose home page is `heights[width]` px tall; records every screenshot. */
const browserOf = (heights: Record<number, number>) => {
  const shots: Shot[] = []
  return {
    shots,
    browser: {
      newContext: async ({ viewport }: { viewport: { width: number } }) => ({
        newPage: async () => ({
          goto: async () => undefined,
          evaluate: async () => heights[viewport.width],
          screenshot: async (shot: Shot) => {
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

describe("cropKey", () => {
  it("sits outside screenshots/, which the router serves", () => {
    expect(cropKey("o", "r", 390, 2)).toBe("sites/o/r/critic/home-390-2.png")
  })
})
