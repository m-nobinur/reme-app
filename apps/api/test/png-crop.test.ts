import { describe, expect, it } from "vitest"
import { cropToMark, encodeRgba } from "../src/png-crop.ts"

const size = (png: Uint8Array) => {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** A transparent `width` by `height` picture with an opaque block. */
function picture(
  width: number,
  height: number,
  block: { x: number; y: number; w: number; h: number }
) {
  const pixels = new Uint8Array(width * height * 4)
  for (let y = block.y; y < block.y + block.h; y++) {
    for (let x = block.x; x < block.x + block.w; x++) {
      pixels.set([20, 120, 110, 255], (y * width + x) * 4)
    }
  }
  return encodeRgba(pixels, width, height)
}

describe("cropToMark", () => {
  it("cuts a logo to the pixels drawn on, with a thin margin", async () => {
    const png = await picture(200, 200, { x: 60, y: 90, w: 80, h: 20 })
    const cut = await cropToMark(png)
    // 80 wide plus 3% of it, about 2 px, on each side.
    expect(size(cut)).toEqual({ width: 84, height: 24 })
    // Cut once, there is nothing more to cut.
    expect(await cropToMark(cut)).toBe(cut)
  })

  it("leaves a picture drawn to its edges, an empty one or a non-PNG as it came", async () => {
    const full = await picture(10, 10, { x: 0, y: 0, w: 10, h: 10 })
    expect(await cropToMark(full)).toBe(full)
    const empty = await picture(10, 10, { x: 0, y: 0, w: 0, h: 0 })
    expect(await cropToMark(empty)).toBe(empty)
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])
    expect(await cropToMark(jpeg)).toBe(jpeg)
  })
})

it("leaves a PNG whose pixels cannot be read as it came", async () => {
  const png = await picture(10, 10, { x: 2, y: 2, w: 3, h: 3 })
  const broken = png.slice()
  // The IDAT's first bytes, past the signature, IHDR and the IDAT header.
  broken.fill(0, 41, 45)
  expect(await cropToMark(broken)).toBe(broken)
})
