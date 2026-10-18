import { inflateSync } from "node:zlib"

/**
 * EV1's measures, pure functions over already-loaded inputs. The runner
 * (../variety.mjs) does the fetching; nothing here touches disk or network.
 */

/**
 * Which `site` field holds each part of the tuple, first non-empty wins:
 * `direction` (a direction id), `font` (a font pair id) and `palette` (the six
 * roles as "paper:#.. ink:#.. primary:#.. ..."), with `brandColor` when the
 * owner named a colour instead. `template` is the starter before VS6, so a
 * baseline build from `main` still reads.
 */
const TUPLE_KEYS = {
  direction: ["direction", "template"],
  pair: ["font"],
  palette: ["palette", "brandColor"],
}

const firstOf = (site, keys) => keys.map((k) => site[k]).find(Boolean) ?? ""

const paletteOf = (p) =>
  !p
    ? ""
    : p.kind === "preset"
      ? p.id
      : p.kind === "brand"
        ? p.brand
        : String(p)

/**
 * `(direction, hero, services, pair, palette)` of one build, as strings.
 * `site` and `layout` are the exports of the revision's `src/site-config.ts`;
 * `blueprint` is the plan the build followed (BA3's shape: `direction`,
 * `fonts`, `palette` as preset id or brand colour), read only for a part the
 * site does not state, because the site is what shipped. A hero with no
 * variant takes its direction's, so it reads as `default/<direction>`.
 */
export function tupleOf({ site, layout, blueprint }) {
  const home = layout?.home ?? []
  const variant = (kind) => home.find((s) => s.kind === kind)?.variant
  return {
    direction:
      firstOf(site, TUPLE_KEYS.direction) || blueprint?.direction || "",
    hero:
      variant("hero") ||
      `default/${site.direction || site.template || "classic"}`,
    services: variant("service_cards") || "none",
    pair: firstOf(site, TUPLE_KEYS.pair) || blueprint?.fonts || "",
    palette: firstOf(site, TUPLE_KEYS.palette) || paletteOf(blueprint?.palette),
  }
}

export const tupleKey = (t) =>
  [t.direction, t.hero, t.services, t.pair, t.palette].join("|")

/** The home page's section order as `kind:variant` tokens. */
export const sequenceOf = (layout) =>
  (layout?.home ?? []).map((s) =>
    s.variant ? `${s.kind}:${s.variant}` : s.kind
  )

/** Levenshtein distance between two token lists: insert, delete, replace, each 1. */
export function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
    prev = row
  }
  return prev[b.length]
}

/** Edit distance over the longer list, so 0 is the same page and 1 shares nothing. */
export const sequenceDistance = (a, b) =>
  a.length === 0 && b.length === 0
    ? 0
    : editDistance(a, b) / Math.max(a.length, b.length)

/**
 * Decode an 8-bit, non-interlaced PNG (what Playwright writes) to a grey
 * image. shortcut: no interlace, no 16-bit, no palette; a screenshot never
 * has them, and decode throws rather than guess if one ever does.
 */
export function decodePng(bytes) {
  const buf = Buffer.from(bytes)
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG")
  let at = 8
  let header
  const idat = []
  while (at < buf.length) {
    const length = buf.readUInt32BE(at)
    const type = buf.toString("latin1", at + 4, at + 8)
    const data = buf.subarray(at + 8, at + 8 + length)
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        color: data[9],
        interlace: data[12],
      }
    } else if (type === "IDAT") idat.push(data)
    else if (type === "IEND") break
    at += 12 + length
  }
  if (!header) throw new Error("PNG has no IHDR")
  const { width, height, depth, color, interlace } = header
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[color]
  if (depth !== 8 || interlace !== 0 || !channels) {
    throw new Error(
      `unsupported PNG (depth ${depth}, colour ${color}, interlace ${interlace})`
    )
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0
      const upLeft =
        y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0
      const p = left + up - upLeft
      const pa = Math.abs(p - left)
      const pb = Math.abs(p - up)
      const pc = Math.abs(p - upLeft)
      const predictor = [
        0,
        left,
        up,
        (left + up) >> 1,
        pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft,
      ][filter]
      if (predictor === undefined) throw new Error(`bad PNG filter ${filter}`)
      pixels[y * stride + x] = (raw[src + x] + predictor) & 255
    }
  }
  const grey = new Float32Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const o = i * channels
    grey[i] =
      channels < 3
        ? pixels[o]
        : 0.299 * pixels[o] + 0.587 * pixels[o + 1] + 0.114 * pixels[o + 2]
  }
  return { width, height, grey }
}

/**
 * Difference hash: shrink to (cols + 1) by rows cells by box averaging, then
 * one bit per cell for "brighter than the cell to its right". `rows` limits
 * the hash to the top of the page (the fold); 0 hashes the whole page. 256
 * bits by default, so section order shows, not just overall tone. Returns an
 * array of 0 and 1.
 * shortcut: a flat page hashes to all zeros whatever its colour, so a palette
 * change is the tuple's job, not the hash's.
 */
export function dhash(image, { cols = 16, rows = 16, topPx = 0 } = {}) {
  const { width, grey } = image
  const height = topPx ? Math.min(topPx, image.height) : image.height
  const bits = []
  const cell = (r, c) => {
    const x0 = Math.floor((c * width) / (cols + 1))
    const x1 = Math.max(x0 + 1, Math.floor(((c + 1) * width) / (cols + 1)))
    const y0 = Math.floor((r * height) / rows)
    const y1 = Math.max(y0 + 1, Math.floor(((r + 1) * height) / rows))
    let sum = 0
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) sum += grey[y * width + x]
    return sum / ((y1 - y0) * (x1 - x0))
  }
  for (let r = 0; r < rows; r++) {
    let left = cell(r, 0)
    for (let c = 1; c <= cols; c++) {
      const right = cell(r, c)
      bits.push(left > right ? 1 : 0)
      left = right
    }
  }
  return bits
}

/** Fraction of differing bits: 0 identical, about 0.5 unrelated. */
export function hashDistance(a, b) {
  if (a.length !== b.length) throw new Error("hashes differ in length")
  return a.reduce((n, bit, i) => n + (bit !== b[i] ? 1 : 0), 0) / a.length
}

const mean = (xs) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null

/** Every unordered pair of a list. */
export const pairs = (xs) =>
  xs.flatMap((x, i) => xs.slice(i + 1).map((y) => [x, y]))

/**
 * The per-industry row. `builds` are `{id, industry, tuple, sequence, hash,
 * foldHash}`. Similarity is 1 minus the mean pairwise distance, so higher is
 * more alike; `dupes` counts pairs whose whole tuple is equal, which must be 0.
 * A build with no screenshot has a null hash and drops out of those means.
 */
export function summarise(builds) {
  const byIndustry = Map.groupBy(builds, (b) => b.industry)
  return [...byIndustry].map(([industry, group]) => {
    const all = pairs(group)
    const sim = (key) =>
      mean(
        all
          .filter(([a, b]) => a[key] && b[key])
          .map(([a, b]) => 1 - hashDistance(a[key], b[key]))
      )
    const distinct = (field) => new Set(group.map((b) => b.tuple[field])).size
    return {
      industry,
      builds: group.length,
      dupes: all.filter(([a, b]) => tupleKey(a.tuple) === tupleKey(b.tuple))
        .length,
      directions: distinct("direction"),
      heroes: distinct("hero"),
      services: distinct("services"),
      pairs: distinct("pair"),
      palettes: distinct("palette"),
      seqDistance: mean(
        all.map(([a, b]) => sequenceDistance(a.sequence, b.sequence))
      ),
      pageSimilarity: sim("hash"),
      foldSimilarity: sim("foldHash"),
    }
  })
}

const cell = (v) =>
  v === null || v === undefined
    ? "n/a"
    : typeof v === "number" && !Number.isInteger(v)
      ? v.toFixed(3)
      : String(v)

/** The summary as a markdown table, with the baseline's similarity beside it when given. */
export function table(rows, baseline = []) {
  const was = new Map(baseline.map((r) => [r.industry, r]))
  const head = [
    "industry",
    "builds",
    "dupes",
    "dirs",
    "heroes",
    "services",
    "pairs",
    "palettes",
    "seq dist",
    "page sim",
    "fold sim",
  ]
  if (baseline.length) head.push("page sim was")
  const lines = rows.map((r) => {
    const base = [
      r.industry,
      r.builds,
      r.dupes,
      r.directions,
      r.heroes,
      r.services,
      r.pairs,
      r.palettes,
      r.seqDistance,
      r.pageSimilarity,
      r.foldSimilarity,
    ]
    if (baseline.length) base.push(was.get(r.industry)?.pageSimilarity)
    return base.map(cell).join(" | ")
  })
  return [head.join(" | "), head.map(() => "---").join(" | "), ...lines]
    .map((l) => `| ${l} |`)
    .join("\n")
}
