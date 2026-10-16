/**
 * The service area drawn as a line map: the main town in the middle, every
 * other town a labelled point around it, the whole inside a loose loop and
 * two rings. No tiles, no coordinates, no network: each position comes from a
 * hash of the town's name, so a site draws the same map on every build. The
 * picture is a sketch of "these places, around this one", never a real map.
 *
 * Every label sits on the side of its point away from the centre and is
 * measured as a box: a point moves outward until its label and dot clear the
 * pin and every other label and dot, and the loop is drawn outside all of
 * them, so no line meets text but the links and rings, which the label's halo
 * (site.css) masks.
 */

import { directionOf } from "./directions"

/** More points than this crowd the drawing; the towns stay listed as text. */
const MAX_POINTS = 8
/** A label's box at 14 units: a generous average glyph width, cap to descender. */
const GLYPH = 8
const ASCENT = 11
const DESCENT = 4
/** Clear space the loop keeps around every label and dot. */
export const LOOP_CLEARANCE = 14

export type Box = { x0: number; y0: number; x1: number; y1: number }
export type AreaLabel = {
  x: number
  y: number
  anchor: "start" | "middle" | "end"
  box: Box
}
export type AreaPoint = { name: string; x: number; y: number; label: AreaLabel }
export type AreaMap = {
  /** The drawing's box, in SVG units. Its foot, under the outer ring, is the card's. */
  box: { width: number; height: number }
  centre: { name: string; x: number; y: number; label: AreaLabel | null }
  /** The filled pin's box, over the main town. */
  pin: Box
  points: AreaPoint[]
  /** A soft curve from the centre to each point. */
  links: string[]
  /** The closed hand-drawn loop around every point. */
  loop: string
  rings: { outer: number; inner: number }
}

/** FNV-1a: small, stable across runtimes, and spreads short names well. */
export function hash(text: string): number {
  let h = 0x811c9dc5
  for (const char of text) {
    h ^= char.codePointAt(0) ?? 0
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 0 to 1 from a hash and a salt, so one name gives several independent draws. */
const unit = (text: string, salt: number) =>
  (hash(`${salt}:${text}`) % 1000) / 1000

const r1 = (n: number) => Math.round(n * 10) / 10

export const overlaps = (a: Box, b: Box) =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1

const dotBox = (x: number, y: number): Box => ({
  x0: x - 6,
  y0: y - 6,
  x1: x + 6,
  y1: y + 6,
})

/** The label of a point at (x, y) from the centre (0, 0), on its far side. */
function labelFor(name: string, x: number, y: number): AreaLabel {
  const w = [...name].length * GLYPH
  const d = Math.hypot(x, y) || 1
  const [dx, dy] = [x / d, y / d]
  if (Math.abs(dx) >= 0.55) {
    const start = dx > 0
    const lx = start ? x + 10 : x - 10
    const ly = y + 5
    return {
      x: lx,
      y: ly,
      anchor: start ? "start" : "end",
      box: {
        x0: start ? lx : lx - w,
        x1: start ? lx + w : lx,
        y0: ly - ASCENT,
        y1: ly + DESCENT,
      },
    }
  }
  const ly = dy < 0 ? y - 12 : y + 22
  return {
    x,
    y: ly,
    anchor: "middle",
    box: { x0: x - w / 2, x1: x + w / 2, y0: ly - ASCENT, y1: ly + DESCENT },
  }
}

type Pt = [number, number]

/** A closed Catmull-Rom curve through the points, as cubic Béziers: start, two controls, end. */
function segments(points: Pt[]): [Pt, Pt, Pt, Pt][] {
  const n = points.length
  const at = (i: number) => points[(i + n) % n]
  return points.map((_, i) => {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)]
    return [
      p1,
      [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6],
      [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6],
      p2,
    ]
  })
}

const pathOf = (curve: [Pt, Pt, Pt, Pt][], by: number) => {
  const xy = ([x, y]: Pt) => `${r1(x + by)} ${r1(y + by)}`
  return `M${xy(curve[0][0])}${curve.map(([, a, b, c]) => `C${xy(a)} ${xy(b)} ${xy(c)}`).join("")}Z`
}

/** Points along a curve, 25 to a segment. */
const samples = (curve: [Pt, Pt, Pt, Pt][]): Pt[] =>
  curve.flatMap(([p, a, b, c]) =>
    Array.from({ length: 25 }, (_, k): Pt => {
      const t = k / 25
      const u = 1 - t
      const w = [u ** 3, 3 * u * u * t, 3 * u * t * t, t ** 3]
      return [
        w[0] * p[0] + w[1] * a[0] + w[2] * b[0] + w[3] * c[0],
        w[0] * p[1] + w[1] * a[1] + w[2] * b[1] + w[3] * c[1],
      ]
    })
  )

/** How far a point is from a box; 0 inside it. */
const gap = ([x, y]: Pt, b: Box) =>
  Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.y0 - y, 0, y - b.y1))

const shift = (b: Box, by: number): Box => ({
  x0: b.x0 + by,
  y0: b.y0 + by,
  x1: b.x1 + by,
  y1: b.y1 + by,
})

/**
 * The map for a list of towns, the first one the centre. `seed` names the
 * area when there are no towns (service_area.text), so the loop still has a
 * shape of its own.
 */
export function areaMap(towns: string[], seed = ""): AreaMap {
  const [main = "", ...rest] = towns
  const others = rest.slice(0, MAX_POINTS)
  const key = main || seed
  const turn = unit(key, 1) * Math.PI * 2
  const step = (Math.PI * 2) / Math.max(others.length, 1)

  // Laid out around (0, 0), moved into the box at the end.
  const pin: Box = { x0: -24, y0: -62, x1: 24, y1: 4 }
  const mainLabel: AreaLabel | null = main
    ? {
        x: 0,
        y: 26,
        anchor: "middle",
        box: {
          x0: (-[...main].length * GLYPH) / 2,
          x1: ([...main].length * GLYPH) / 2,
          y0: 26 - ASCENT,
          y1: 26 + DESCENT,
        },
      }
    : null
  const taken: Box[] = [pin, ...(mainLabel ? [mainLabel.box] : [])]
  const placed: { name: string; x: number; y: number; label: AreaLabel }[] = []
  others.forEach((name, i) => {
    // Evenly spread, nudged by the name, alternately near and far, then
    // moved outward until the dot and its label touch nothing drawn yet.
    const angle = turn + i * step + (unit(name, 2) - 0.5) * step * 0.5
    let radius = (i % 2 ? 132 : 100) + (unit(name, 3) - 0.5) * 16
    for (let tries = 0; ; tries++) {
      const x = Math.cos(angle) * radius
      const y = Math.sin(angle) * radius * 0.86
      const label = labelFor(name, x, y)
      const mine = [label.box, dotBox(x, y)]
      if (
        tries === 40 ||
        !mine.some((b) => taken.some((t) => overlaps(b, t)))
      ) {
        taken.push(...mine)
        placed.push({ name, x, y, label })
        break
      }
      radius += 10
    }
  })

  // The loop: twelve spokes, each past every corner near its angle by the
  // clearance and a little more, outward only, by the name.
  const corners = taken.flatMap((b) => [
    [b.x0, b.y0],
    [b.x1, b.y0],
    [b.x0, b.y1],
    [b.x1, b.y1],
  ])
  const spokes = 12
  const arc = (Math.PI * 2) / spokes
  const reach = Array.from({ length: spokes }, (_, i) => {
    const angle = turn + i * arc
    const near = corners
      .filter(([x, y]) => {
        const diff = Math.abs(
          ((Math.atan2(y, x) - angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI
        )
        return diff <= arc * 1.5
      })
      .map(([x, y]) => Math.hypot(x, y))
    return Math.max(130, ...near) + LOOP_CLEARANCE + 8 + unit(key, 10 + i) * 18
  })
  // Between spokes the curve can dip inward: wherever it comes nearer a box
  // than the clearance, the two spokes either side move out, until none do.
  const spokeAngle = (i: number) => turn + i * arc
  const curveOf = () =>
    segments(
      reach.map(
        (r, i): Pt => [Math.cos(spokeAngle(i)) * r, Math.sin(spokeAngle(i)) * r]
      )
    )
  let curve = curveOf()
  for (let round = 0; round < 40; round++) {
    const close = samples(curve).findIndex((pt) =>
      taken.some((t) => gap(pt, t) < LOOP_CLEARANCE)
    )
    if (close < 0) break
    const i = Math.floor(close / 25)
    reach[i] += 6
    reach[(i + 1) % spokes] += 6
    curve = curveOf()
  }
  const outer =
    Math.max(...samples(curve).map(([x, y]) => Math.hypot(x, y))) + 18
  const c = outer + 6
  const width = 2 * c
  const at = (x: number, y: number) => ({ x: r1(x + c), y: r1(y + c) })
  const points = placed.map(({ name, x, y, label }) => ({
    name,
    ...at(x, y),
    label: { ...label, ...at(label.x, label.y), box: shift(label.box, c) },
  }))
  const links = points.map(({ x, y }) => {
    // Bowed to one side, by the same amount each build.
    const mx = (c + x) / 2 + (c - y) * 0.18
    const my = (c + y) / 2 + (x - c) * 0.18
    return `M${c} ${c}Q${r1(mx)} ${r1(my)} ${x} ${y}`
  })
  return {
    // The foot under the ring is the card's (site.css).
    box: { width: r1(width), height: r1(width * 1.26) },
    centre: {
      name: main,
      x: r1(c),
      y: r1(c),
      label: mainLabel && {
        ...mainLabel,
        ...at(mainLabel.x, mainLabel.y),
        box: shift(mainLabel.box, c),
      },
    },
    pin: shift(pin, c),
    points,
    links,
    loop: pathOf(curve, c),
    rings: { outer: r1(outer), inner: r1(outer * 0.72) },
  }
}

/** areaTowns' places, one to a line. */
export const areaTowns = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

/** areaTownNotes as "Town: a short line", keyed by the town in lower case. */
export const townNotes = (text: string) =>
  new Map(
    areaTowns(text).flatMap((line) => {
      const cut = line.indexOf(":")
      const note = line.slice(cut + 1).trim()
      return cut > 0 && note
        ? [[line.slice(0, cut).trim().toLowerCase(), note] as const]
        : []
    })
  )

/**
 * The area band is deep where the direction keeps one dark band (the
 * closing one), so the page gets a second; a direction with two already, or
 * a dark page, keeps it light.
 */
export const areaDeep = (direction: string) =>
  directionOf(direction).bands === "one_dark"
