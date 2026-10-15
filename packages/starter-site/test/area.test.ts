import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import {
  areaDeep,
  areaMap,
  type Box,
  LOOP_CLEARANCE,
  overlaps,
  townNotes,
} from "../src/area-map"
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

  // Long names, many towns, few, none: each its own layout.
  const SETS = [
    TOWNS,
    ["Fairhaven"],
    [],
    ["A", "B"],
    ["Fairhaven", "Oakley", "Brook Green"],
    [
      "Leeds",
      "Headingley",
      "Chapel Allerton",
      "Roundhay",
      "Horsforth",
      "Kirkstall",
      "Meanwood",
      "Moortown",
      "Alwoodley",
      "Shadwell",
    ],
    [
      "Bath",
      "Bradford-on-Avon",
      "Midsomer Norton",
      "Keynsham",
      "Saltford",
      "Peasedown St John",
      "Radstock",
    ],
  ]
  const dot = (x: number, y: number): Box => ({
    x0: x - 4,
    y0: y - 4,
    x1: x + 4,
    y1: y + 4,
  })
  /** The loop's path, sampled along each of its cubic segments. */
  const loopSamples = (d: string) => {
    const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
    let [px, py] = nums
    const out: [number, number][] = []
    for (let i = 2; i + 5 < nums.length; i += 6) {
      const [ax, ay, bx, by, cx, cy] = nums.slice(i, i + 6)
      for (let t = 0; t <= 1; t += 0.02) {
        const u = 1 - t
        out.push([
          u ** 3 * px + 3 * u * u * t * ax + 3 * u * t * t * bx + t ** 3 * cx,
          u ** 3 * py + 3 * u * u * t * ay + 3 * u * t * t * by + t ** 3 * cy,
        ])
      }
      ;[px, py] = [cx, cy]
    }
    return out
  }
  const gap = ([x, y]: [number, number], b: Box) =>
    Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.y0 - y, 0, y - b.y1))

  test.each(SETS.map((towns) => [towns.length, towns] as const))(
    "sets each label on its point's far side, clear of the others and of the loop (%i towns)",
    (_, towns) => {
      const map = areaMap(towns)
      const { x: cx, y: cy } = map.centre
      const boxes = map.points.flatMap((p) => [p.label.box, dot(p.x, p.y)])
      const all = [
        map.pin,
        ...(map.centre.label ? [map.centre.label.box] : []),
        ...boxes,
      ]
      for (const p of map.points) {
        const b = p.label.box
        const mid = Math.hypot((b.x0 + b.x1) / 2 - cx, (b.y0 + b.y1) / 2 - cy)
        expect(mid, p.name).toBeGreaterThan(Math.hypot(p.x - cx, p.y - cy))
        for (const other of all) {
          if (other === b || other === boxes[boxes.indexOf(b) + 1]) continue
          expect(overlaps(b, other), `${p.name} meets something`).toBe(false)
        }
      }
      for (const point of loopSamples(map.loop)) {
        for (const b of all)
          expect(gap(point, b)).toBeGreaterThan(LOOP_CLEARANCE / 2)
        expect(point[0]).toBeGreaterThan(0)
        expect(point[0]).toBeLessThan(map.box.width)
        expect(point[1]).toBeLessThan(cy + map.rings.outer)
      }
      for (const b of all) {
        expect(b.x0).toBeGreaterThan(0)
        expect(b.x1).toBeLessThan(map.box.width)
        expect(b.y0).toBeGreaterThan(0)
        expect(b.y1).toBeLessThan(cy + map.rings.outer)
      }
    }
  )

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
