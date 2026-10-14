import assert from "node:assert/strict"
import { test } from "node:test"
import { deflateSync } from "node:zlib"
import { AskDesignOutput, FactValue } from "@workspace/contracts"
import { BUSINESSES, toFacts, toTray } from "./businesses.mjs"
import {
  decodePng,
  dhash,
  editDistance,
  hashDistance,
  sequenceDistance,
  sequenceOf,
  summarise,
  table,
  tupleKey,
  tupleOf,
} from "./measures.mjs"

// fixtures

const by = (industry) => BUSINESSES.filter((b) => b.industry === industry)

test("18 fictional businesses, six in each of three industries", () => {
  assert.equal(BUSINESSES.length, 18)
  for (const industry of ["cleaning", "legal", "limousine"]) {
    assert.equal(by(industry).length, 6)
  }
  for (const key of ["id", "name", "phone", "email", "town"]) {
    assert.equal(
      new Set(BUSINESSES.map((b) => b[key])).size,
      18,
      `${key} is unique`
    )
  }
})

test("no contact detail can belong to a real business", () => {
  for (const b of BUSINESSES) {
    assert.match(
      b.phone,
      /^\+1\d{3}5550[1]\d\d$/,
      `${b.id} phone is in 555-0100 to 555-0199`
    )
    assert.match(
      b.email,
      /^hello@[a-z]+\.example\.com$/,
      `${b.id} email is on example.com`
    )
  }
})

test("richness and tray mix: two of each six at each richness, three answer", () => {
  for (const industry of ["cleaning", "legal", "limousine"]) {
    const group = by(industry)
    for (const richness of ["bare", "photos", "full"]) {
      assert.equal(
        group.filter((b) => b.richness === richness).length,
        2,
        `${industry} ${richness}`
      )
    }
    assert.equal(group.filter((b) => b.tray === "answer").length, 3)
    const picks = group
      .filter((b) => b.tray === "answer")
      .map((b) => JSON.stringify(toTray(b)))
    assert.equal(
      new Set(picks).size,
      2,
      "two answerers pick alike, the third differs"
    )
  }
})

test("photos follow richness", () => {
  const uploads = (b) =>
    toFacts(b).find((f) => f.key === "media.uploads")?.value.items.length ?? 0
  for (const b of BUSINESSES)
    assert.equal(uploads(b), b.richness === "bare" ? 0 : 3, b.id)
})

test("every fact and tray answer is contract-shaped", () => {
  for (const b of BUSINESSES) {
    for (const fact of toFacts(b)) {
      const parsed = FactValue.safeParse(fact)
      assert.ok(parsed.success, `${b.id} ${fact.key}: ${parsed.error?.message}`)
    }
    const parsed = AskDesignOutput.safeParse(toTray(b))
    assert.ok(parsed.success, `${b.id} tray: ${parsed.error?.message}`)
  }
})

// measures

test("edit distance counts insert, delete and replace", () => {
  assert.equal(editDistance(["a", "b", "c"], ["a", "b", "c"]), 0)
  assert.equal(editDistance(["a", "b", "c"], ["a", "c"]), 1)
  assert.equal(editDistance(["a", "b"], ["x", "b", "y"]), 2)
  assert.equal(editDistance([], ["a", "b"]), 2)
  assert.equal(sequenceDistance(["a", "b"], ["c", "d"]), 1)
  assert.equal(sequenceDistance([], []), 0)
})

test("the tuple reads the layout and falls back to the legacy template for a build from main", () => {
  const layout = {
    home: [
      { kind: "hero", variant: "split_arch" },
      { kind: "service_cards", variant: "fleet" },
      { kind: "cta_band" },
    ],
  }
  assert.deepEqual(
    tupleOf({
      site: { template: "bold", font: "clean_sans", brandColor: "brand-teal" },
      layout,
    }),
    {
      direction: "bold",
      hero: "split_arch",
      services: "fleet",
      pair: "clean_sans",
      palette: "brand-teal",
    }
  )
  const old = tupleOf({
    site: { template: "modern" },
    layout: { home: [{ kind: "hero" }] },
  })
  assert.equal(old.hero, "default/modern")
  assert.equal(old.services, "none")
  const planned = tupleOf({
    site: {
      direction: "calm_daylight",
      font: "outfit_figtree",
      palette: "paper:a ink:b primary:c",
    },
    layout,
  })
  assert.equal(
    tupleKey(planned),
    "calm_daylight|split_arch|fleet|outfit_figtree|paper:a ink:b primary:c"
  )
  // A part the site leaves empty falls back to the Blueprint (BA3's shape).
  const fromPlan = tupleOf({
    site: { direction: "calm_daylight" },
    layout,
    blueprint: {
      direction: "bold_editorial",
      fonts: "outfit_figtree",
      palette: { kind: "preset", id: "lagoon" },
    },
  })
  assert.deepEqual(
    [fromPlan.direction, fromPlan.pair, fromPlan.palette],
    ["calm_daylight", "outfit_figtree", "lagoon"]
  )
  assert.deepEqual(sequenceOf(layout), [
    "hero:split_arch",
    "service_cards:fleet",
    "cta_band",
  ])
})

/** A PNG of width x height whose grey comes from `grey(x, y)`, each row stored with filter type `filter`. */
function png(width, height, grey, filter = 0, color = 0) {
  const channels = color === 6 ? 4 : 1
  const row = (y) =>
    Uint8Array.from({ length: width * channels }, (_, i) =>
      i % channels === 3 ? 255 : grey(Math.floor(i / channels), y)
    )
  const rows = Array.from({ length: height }, (_, y) => row(y))
  const out = []
  rows.forEach((r, y) => {
    out.push(filter)
    r.forEach((v, x) => {
      const left = x >= channels ? r[x - channels] : 0
      const up = y ? rows[y - 1][x] : 0
      const upLeft = y && x >= channels ? rows[y - 1][x - channels] : 0
      const p = left + up - upLeft
      const paeth =
        Math.abs(p - left) <= Math.abs(p - up) &&
        Math.abs(p - left) <= Math.abs(p - upLeft)
          ? left
          : Math.abs(p - up) <= Math.abs(p - upLeft)
            ? up
            : upLeft
      out.push((v - [0, left, up, (left + up) >> 1, paeth][filter]) & 255)
    })
  })
  const chunk = (type, data) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length)
    head.write(type, 4, "latin1")
    return Buffer.concat([head, data, Buffer.alloc(4)]) // the decoder does not check the CRC
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = color
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from(out))),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

const stripes = (x, y) => ((x * 7 + y * 13) % 5) * 50 // a texture where every filter changes bytes

test("the PNG decoder reads all five filters back to the same pixels", () => {
  for (const filter of [0, 1, 2, 3, 4]) {
    for (const color of [0, 6]) {
      const image = decodePng(png(23, 9, stripes, filter, color))
      assert.equal(image.width, 23)
      assert.equal(image.height, 9)
      assert.equal(
        Math.round(image.grey[4 * 23 + 5]),
        stripes(5, 4),
        `filter ${filter} colour ${color}`
      )
    }
  }
})

test("the hash separates different layouts and holds still for the same one", () => {
  const hash = (fn, h = 400) => dhash(decodePng(png(160, h, fn)))
  const bandsAcross = (x) => (Math.floor(x / 20) % 2 ? 230 : 20) // light and dark columns
  const bandsDown = (_x, y) => (Math.floor(y / 25) % 2 ? 230 : 20) // light and dark rows
  const gradient = (x) => Math.floor((x / 160) * 255)
  assert.equal(hashDistance(hash(bandsAcross), hash(bandsAcross)), 0)
  assert.ok(hashDistance(hash(bandsAcross), hash(bandsDown)) > 0.25)
  assert.ok(hashDistance(hash(gradient), hash(bandsAcross)) > 0.25)
  // Same layout on a taller page still reads as the same page.
  assert.ok(hashDistance(hash(bandsDown, 400), hash(bandsDown, 800)) < 0.1)
  assert.equal(hash(gradient).length, 256)
  // The fold crops: a page whose top is the same and bottom differs hashes equal there.
  const topSame = (x, y) => (y < 100 ? bandsAcross(x) : bandsDown(x, y))
  const fold = (fn) => dhash(decodePng(png(160, 400, fn)), { topPx: 100 })
  assert.equal(hashDistance(fold(topSame), fold(bandsAcross)), 0)
})

test("the summary counts duplicate tuples and averages similarity per industry", () => {
  const same = {
    direction: "a",
    hero: "h",
    services: "s",
    pair: "p",
    palette: "x",
  }
  const build = (id, tuple, bits, sequence) => ({
    id,
    industry: "cleaning",
    tuple,
    sequence,
    hash: bits,
    foldHash: bits,
  })
  const [row] = summarise([
    build("1", same, [0, 0, 1, 1], ["hero", "faq"]),
    build("2", same, [0, 0, 1, 1], ["hero", "faq"]),
    build("3", { ...same, direction: "b" }, [1, 1, 0, 0], ["faq", "hero"]),
  ])
  assert.equal(row.builds, 3)
  assert.equal(row.dupes, 1)
  assert.equal(row.directions, 2)
  assert.equal(row.heroes, 1)
  // Pairs: (1,2) similarity 1, (1,3) 0, (2,3) 0.
  assert.ok(Math.abs(row.pageSimilarity - 1 / 3) < 1e-9)
  assert.ok(Math.abs(row.seqDistance - 2 / 3) < 1e-9)
  assert.match(
    table([row], [{ industry: "cleaning", pageSimilarity: 0.9 }]),
    /0\.900/
  )
})
