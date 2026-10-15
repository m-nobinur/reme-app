/**
 * The service area drawn as a line map: the main town in the middle, every
 * other town a labelled point around it, the whole inside a loose loop and
 * two rings. No tiles, no coordinates, no network: each position comes from a
 * hash of the town's name, so a site draws the same map on every build. The
 * picture is a sketch of "these places, around this one", never a real map.
 */

import { directionOf } from "./directions"

/** The drawing's box, in SVG units; the page scales it. Below the outer ring
 * is room for the card (site.css), so it never covers a town. */
export const AREA_BOX = { width: 480, height: 520 }
const CX = 240
const CY = 220
/** More points than this crowd the drawing; the towns stay listed as text. */
const MAX_POINTS = 8

export type AreaPoint = { name: string; x: number; y: number; above: boolean }
export type AreaMap = {
  centre: { name: string; x: number; y: number }
  points: AreaPoint[]
  /** A soft curve from the centre to each point. */
  links: string[]
  /** The closed hand-drawn loop around every point. */
  loop: string
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

/** A closed Catmull-Rom curve through the points, as cubic Béziers. */
function closedCurve(points: [number, number][]): string {
  const n = points.length
  const at = (i: number) => points[(i + n) % n]
  let d = `M${r1(at(0)[0])} ${r1(at(0)[1])}`
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)]
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += `C${r1(c1[0])} ${r1(c1[1])} ${r1(c2[0])} ${r1(c2[1])} ${r1(p2[0])} ${r1(p2[1])}`
  }
  return `${d}Z`
}

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
  const points = others.map((name, i): AreaPoint => {
    // Evenly spread, nudged by the name, and alternately near and far so
    // neighbours' labels do not meet.
    const angle = turn + i * step + (unit(name, 2) - 0.5) * step * 0.5
    const radius = (i % 2 ? 138 : 104) + (unit(name, 3) - 0.5) * 20
    const y = CY + Math.sin(angle) * radius * 0.86
    return {
      name,
      x: r1(CX + Math.cos(angle) * radius),
      y: r1(y),
      above: y < CY,
    }
  })
  const links = points.map(({ x, y }) => {
    // Bowed to one side, by the same amount each build.
    const mx = (CX + x) / 2 + (CY - y) * 0.18
    const my = (CY + y) / 2 + (x - CX) * 0.18
    return `M${CX} ${CY}Q${r1(mx)} ${r1(my)} ${x} ${y}`
  })
  // The loop passes outside every point: seven spokes, each as far out as
  // the furthest point near its angle, plus a wobble from the name.
  const spokes = 7
  const loopPoints = Array.from(
    { length: spokes },
    (_, i): [number, number] => {
      const angle = turn + (i * Math.PI * 2) / spokes
      const reach = Math.max(
        150,
        ...points.map((p) => {
          const a = Math.atan2((p.y - CY) / 0.86, p.x - CX)
          const near = Math.cos(a - angle)
          return near > 0.6 ? Math.hypot(p.x - CX, (p.y - CY) / 0.86) + 30 : 0
        })
      )
      const r = Math.min(reach + (unit(key, 10 + i) - 0.5) * 34, 196)
      return [CX + Math.cos(angle) * r * 1.04, CY + Math.sin(angle) * r * 0.84]
    }
  )
  return {
    centre: { name: main, x: CX, y: CY },
    points,
    links,
    loop: closedCurve(loopPoints),
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
