import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { AREA_BOX, areaDeep, areaMap, townNotes } from "../src/area-map"
import { type Built, build, clean } from "./build"
import { FILLED } from "./fixture"

const TOWNS = [
  "Bristol",
  "Clifton",
  "Redland",
  "Bishopston",
  "Cotham",
  "Southville",
  "Westbury-on-Trym",
]

describe("the area drawing", () => {
  test("places the same towns in the same places on every build", () => {
    expect(areaMap(TOWNS)).toEqual(areaMap([...TOWNS]))
    expect(areaMap(TOWNS).points).not.toEqual(
      areaMap(["Bath", ...TOWNS.slice(1)]).points
    )
  })

  test("keeps every point and its label inside the box, clear of the card", () => {
    for (const towns of [TOWNS, ["Fairhaven"], [], ["A", "B"]]) {
      for (const { x, y } of areaMap(towns).points) {
        expect(x).toBeGreaterThan(60)
        expect(x).toBeLessThan(AREA_BOX.width - 60)
        // Labels sit 21 units under a point; the card owns the box's foot.
        expect(y + 21).toBeLessThan(380)
        expect(y - 11).toBeGreaterThan(40)
      }
    }
  })

  test("reads town lines only for a town and a line", () => {
    expect([
      ...townNotes("Clifton: flats\nRedland\nCotham:\n: nothing").entries(),
    ]).toEqual([["clifton", "flats"]])
  })

  test("is deep only where the direction keeps one dark band", () => {
    expect(areaDeep("calm_daylight")).toBe(true)
    expect(areaDeep("warm_editorial")).toBe(false)
    expect(areaDeep("after_dark")).toBe(false)
  })
})

describe("the area section, built", () => {
  let built: Built | undefined
  const site = {
    ...FILLED,
    direction: "calm_daylight",
    areaTowns: TOWNS.join("\n"),
    weekdayHours: "08:00 to 17:00",
    areaCardLine: "Right around the corner",
    areaTownNotes: "Clifton: Georgian terraces and flats",
  }
  beforeAll(async () => {
    built = await build({ site })
  }, 180_000)
  afterAll(() => clean(built))
  const page = (path: string) =>
    readFileSync(join(built?.dist ?? "", path), "utf8")

  test("lists every town as text beside a small, hidden drawing", () => {
    const html = page("index.html")
    const section = /<section class="[^"]*area-section[\s\S]*?<\/section>/.exec(
      html
    )?.[0]
    expect(section).toContain("area-deep")
    const art =
      /<div class="area-art[^"]*" aria-hidden="true">[\s\S]*?<\/svg>/.exec(
        section ?? ""
      )?.[0]
    expect(art).toBeDefined()
    expect(Buffer.byteLength(art ?? "")).toBeLessThan(10_000)
    const text = (section ?? "").replace(
      /<div class="area-art[\s\S]*?<\/svg>/,
      ""
    )
    for (const town of TOWNS)
      expect(text).toContain(`<span data-copy="area_town">${town}</span>`)
    expect(text).toContain("Weekdays 08:00 to 17:00")
    expect(section).toContain("Right around the corner")
  })

  test("draws the service area page's cover and lists its towns with their lines", () => {
    const html = page("service-area/index.html")
    expect(html).toMatch(/class="hero hero-page hero-cover area-deep"/)
    expect(html.match(/class="area-art/g)).toHaveLength(1)
    expect(html).toContain("Georgian terraces and flats")
    for (const town of TOWNS) expect(html).toContain(`>${town}</span>`)
  })
})
