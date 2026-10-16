import assert from "node:assert/strict"
import { test } from "node:test"
import {
  laneRows,
  parseLine,
  percentile,
  photosOf,
  render,
  roleRows,
  timingsOf,
  turnsOf,
} from "./stats.mjs"

const timing = (o) =>
  JSON.stringify({
    type: "revise.timing",
    kind: "site.revise",
    outcome: "preview_ready",
    ...o,
  })
const turn = (assignment_id, role, usage) =>
  JSON.stringify({
    type: "runtime.turn",
    assignment_id,
    payload: { role, response: { usage } },
  })

test("nearest-rank percentiles", () => {
  assert.equal(percentile([], 0.5), null)
  assert.equal(percentile([5], 0.95), 5)
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2)
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10)
  assert.equal(percentile([1, null, 3], 0.5), 1)
})

test("a timing line is found under a tail prefix and inside a Workers Logs row", () => {
  const bare = timing({ lane: "quick" })
  assert.equal(parseLine(`2026-10-14T10:00:00Z  (log) ${bare}`).lane, "quick")
  assert.equal(parseLine(JSON.stringify({ message: bare })).lane, "quick")
  assert.equal(
    parseLine(JSON.stringify({ message: JSON.parse(bare) })).lane,
    "quick"
  )
  assert.equal(parseLine("not json at all"), null)
  assert.equal(parseLine("{broken"), null)
  assert.equal(timingsOf(`noise\n${bare}\n{"type":"other"}\n`).length, 1)
})

test("lanes get percentiles, cost from the turns, and the baseline of the same kind", () => {
  const lines = [
    ...[10_000, 14_000, 18_000, 22_000].map((ms, i) =>
      timing({
        assignment_id: `q${i}`,
        lane: "quick",
        change_kind: "copy",
        preview_ready_ms: ms,
        end_to_end_ms: ms + 8_000,
      })
    ),
    timing({
      assignment_id: "f0",
      lane: "full",
      change_kind: "creative",
      preview_ready_ms: 200_000,
      end_to_end_ms: 230_000,
    }),
    timing({
      assignment_id: "f1",
      lane: "full",
      change_kind: "creative",
      outcome: "failed",
      preview_ready_ms: null,
      end_to_end_ms: 90_000,
    }),
  ].join("\n")
  const base = [
    timing({ end_to_end_ms: 80_000 }),
    timing({ end_to_end_ms: 120_000 }),
    timing({ end_to_end_ms: 300_000 }),
  ].join("\n")
  const turns = [
    turn("q0", "quick_copy", { input: 100, cost: { total: 0.01 } }),
    turn("q0", "quick_copy", { input: 100, cost: { total: 0.005 } }),
    turn("q1", "quick_copy", { input: 100, cost: { total: 0.02 } }),
    turn("f0", "build", { input: 100, cost: { total: 1 } }),
  ].join("\n")
  const rows = laneRows(timingsOf(lines), turnsOf(turns), timingsOf(base))
  const quick = rows.find((r) => r.lane === "quick:copy")
  assert.equal(quick.n, 4)
  assert.equal(quick.readyP50, 14)
  assert.equal(quick.readyP95, 22)
  assert.equal(quick.wallP50, 22)
  assert.equal(quick.baselineP50, 120)
  assert.equal(quick.costN, 2)
  assert.ok(Math.abs(quick.costP50 - 0.015) < 1e-9)
  const full = rows.find((r) => r.lane === "full:creative")
  assert.equal(full.n, 2)
  assert.equal(full.readyP50, 200) // the failed build has no preview and drops out
  assert.equal(full.wallP95, 230)
})

test("images per build and their cost come from site.photos, per lane", () => {
  const photo = (assignment_id, payload) =>
    JSON.stringify({ type: "site.photos", assignment_id, payload })
  const slot = (id, resolution, asset_id) => ({
    id,
    source: "generated",
    resolution,
    ...(asset_id ? { asset_id } : {}),
  })
  const photos = photosOf(
    [
      photo("f0", {
        slots: [
          slot("hero", "2K", "a"),
          slot("b", "1K", "b"),
          slot("c", "1K"),
          { id: "u", source: "upload", resolution: "1K", asset_id: "u" },
        ],
        regenerated: null,
      }),
      // a lone redraw drew one slot, not the whole list
      photo("r0", {
        slots: [slot("hero", "2K", "a"), slot("b", "1K", "b")],
        regenerated: "b",
      }),
      photo("f1", { slots: [slot("hero", "2K", "a")], cost_usd: 0.07 }),
    ].join("\n")
  )
  assert.deepEqual(photos.get("f0"), { images: 2, cost: 0.084 })
  assert.deepEqual(photos.get("r0"), { images: 1, cost: 0.034 })
  const lines = [
    timing({ assignment_id: "f0", lane: "full", change_kind: "creative" }),
    timing({ assignment_id: "f1", lane: "full", change_kind: "creative" }),
    timing({ assignment_id: "r0", lane: "quick", change_kind: "photo" }),
    timing({ assignment_id: "q9", lane: "quick", change_kind: "copy" }),
  ].join("\n")
  const rows = laneRows(timingsOf(lines), [], [], photos)
  const full = rows.find((r) => r.lane === "full:creative")
  assert.equal(full.imagesN, 2)
  assert.equal(full.imagesP50, 1)
  assert.equal(full.imageCostP50, 0.07)
  assert.equal(rows.find((r) => r.lane === "quick:photo").imagesP50, 1)
  assert.equal(rows.find((r) => r.lane === "quick:copy").imagesN, 0)
})

test("cache-read ratio is per role and counts written tokens as prompt", () => {
  const turns = turnsOf(
    [
      turn("a", "build", {
        input: 100,
        cacheRead: 700,
        cacheWrite: 200,
        cost: { total: 1 },
      }),
      turn("a", "build", {
        input: 100,
        cacheRead: 800,
        cacheWrite: 100,
        cost: { total: 1 },
      }),
      turn("a", "quick_copy", {
        input: 500,
        cacheRead: 0,
        cost: { total: 0.01 },
      }),
    ].join("\n")
  )
  const rows = roleRows(turns)
  const build = rows.find((r) => r.role === "build")
  assert.equal(build.promptTokens, 2000)
  assert.equal(build.ratio, 0.75)
  assert.equal(rows.find((r) => r.role === "quick_copy").ratio, 0)
  assert.match(render([], rows), /75\.0%/)
})
