import { PALETTES } from "@workspace/contracts"
import {
  AA,
  contrast,
  hexColour,
  nextShown,
  textOn,
  whiteContrast,
} from "@workspace/ui/lib/colour"
import { expect, it } from "vitest"

/**
 * The colour card's helpers. Colours come from the contract's palettes, so
 * this file holds no colour literal for the lint rule to refuse.
 */

const ocean = PALETTES[0]?.brand ?? ""
const tint = PALETTES[0]?.swatches[1] ?? ""

it("reads a colour code in any case and with three digits, and nothing else", () => {
  expect(hexColour(` ${ocean.toUpperCase()} `)).toBe(ocean)
  const short = ocean.slice(0, 4)
  expect(hexColour(short)).toBe(
    `#${[...short.slice(1)].map((digit) => digit + digit).join("")}`
  )
  for (const text of ["", "Navy and gold", ocean.slice(1), ocean.slice(0, 5)]) {
    expect(hexColour(text), text).toBeNull()
  }
})

it("carries text that reads on every preset, white where white does, and not white on a tint", () => {
  const white = textOn(ocean)
  for (const palette of PALETTES) {
    const text = textOn(palette.brand)
    // A light brand (champagne) takes dark text, not a white that fails AA.
    expect(contrast(text, palette.brand), palette.id).toBeGreaterThanOrEqual(AA)
    if (whiteContrast(palette.brand) >= AA) expect(text, palette.id).toBe(white)
  }
  expect(whiteContrast(tint)).toBeLessThan(AA)
  expect(textOn(tint)).not.toBe(textOn(ocean))
  // White on white: the text on a preset is white.
  expect(whiteContrast(textOn(ocean))).toBe(1)
})

/** A random source that walks a fixed list, so a failure replays. */
const seeded = () => {
  let n = 0
  return () => ((n++ * 7919) % 101) / 101
}

it("shows every option once before any repeats, and never the same four twice running", () => {
  const ids: string[] = PALETTES.map((p) => p.id)
  const random = seeded()
  let shown = ids.slice(0, 4)
  let seen = [...shown]
  const round = [...shown]
  // Whole pages first, none repeating; the odd ones left over come on the last.
  for (let press = 0; press < Math.floor(ids.length / 4) - 1; press++) {
    const next = nextShown(ids, shown, seen, random)
    expect(next.shown).toHaveLength(4)
    expect(next.shown.some((id) => shown.includes(id))).toBe(false)
    round.push(...next.shown)
    ;({ shown, seen } = next)
  }
  if (ids.length % 4) {
    const last = nextShown(ids, shown, seen, random)
    expect(last.shown).toHaveLength(4)
    expect(last.shown.some((id) => shown.includes(id))).toBe(false)
    round.push(...last.shown)
    ;({ shown, seen } = last)
  }
  expect(new Set(round)).toEqual(new Set(ids))
  // The pool is spent: a new round starts, still without the current four.
  const again = nextShown(ids, shown, seen, random)
  expect(again.shown.some((id) => shown.includes(id))).toBe(false)
  // The leftover page already started the new round; otherwise this one does.
  if (ids.length % 4 === 0) expect(again.seen).toEqual(again.shown)
})

it("shows the last unseen options first when fewer than a page are left", () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]
  const next = nextShown(
    ids,
    ["e", "f", "g", "h"],
    ["a", "b", "c", "d", "e", "f", "g", "h"],
    seeded()
  )
  expect(next.shown).toHaveLength(4)
  expect(next.shown).toEqual(expect.arrayContaining(["i", "j"]))
  expect(next.shown.filter((id) => ["e", "f", "g", "h"].includes(id))).toEqual(
    []
  )
})
