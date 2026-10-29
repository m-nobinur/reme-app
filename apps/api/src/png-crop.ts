/**
 * A drawn logo cut to its mark. The image model centres the logo on a 1024 px
 * transparent square with a wide margin, so in a 40 px header the mark was a
 * fraction of its box and a bigger box hardly showed (2026-10-29). This keeps
 * the pixels anything is drawn on, with a thin margin, and leaves every other
 * PNG as it came: only 8-bit RGBA without interlacing is read, which is what
 * the GPT Image models send.
 */

/** Alpha at or below this is the background's soft edge, not the mark. */
const SEEN = 8

/** The margin kept around the mark, as a share of its longer side. */
const MARGIN = 0.03

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

type Chunk = { name: string; data: Uint8Array }

function chunksOf(bytes: Uint8Array): Chunk[] | null {
  if (!SIGNATURE.every((b, i) => bytes[i] === b)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const chunks: Chunk[] = []
  for (let at = 8; at + 12 <= bytes.length; ) {
    const length = view.getUint32(at)
    const name = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
    chunks.push({ name, data: bytes.subarray(at + 8, at + 8 + length) })
    at += 12 + length
    if (name === "IEND") break
  }
  return chunks
}

async function through(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream
): Promise<Uint8Array> {
  const out = new Blob([bytes]).stream().pipeThrough(stream)
  return new Uint8Array(await new Response(out).arrayBuffer())
}

/** The scanlines with their filters undone (PNG spec §9), four bytes a pixel. */
function unfilter(raw: Uint8Array, width: number, height: number) {
  const stride = width * 4
  const pixels = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const row = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? (pixels[row + x - 4] ?? 0) : 0
      const b = y > 0 ? (pixels[row - stride + x] ?? 0) : 0
      const c = x >= 4 && y > 0 ? (pixels[row - stride + x - 4] ?? 0) : 0
      const byte = line[x] ?? 0
      let value = byte
      if (filter === 1) value = byte + a
      else if (filter === 2) value = byte + b
      else if (filter === 3) value = byte + ((a + b) >> 1)
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value = byte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
      }
      pixels[row + x] = value & 0xff
    }
  }
  return pixels
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function chunk(name: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = name.charCodeAt(i)
  out.set(data, 8)
  let crc = 0xffffffff
  for (const byte of out.subarray(4, 8 + data.length)) {
    crc = (CRC[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  }
  view.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0)
  return out
}

/** An 8-bit RGBA PNG of `pixels`, every scanline unfiltered. */
export async function encodeRgba(
  pixels: Uint8Array,
  width: number,
  height: number
): Promise<Uint8Array> {
  const stride = width * 4
  const raw = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header.set([8, 6, 0, 0, 0], 8)
  const parts = [
    Uint8Array.from(SIGNATURE),
    chunk("IHDR", header),
    chunk("IDAT", await through(raw, new CompressionStream("deflate"))),
    chunk("IEND", new Uint8Array()),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** `bytes` cut to the pixels anything is drawn on, with a thin margin; as they came when they cannot be read or are drawn edge to edge. */
export async function cropToMark(bytes: Uint8Array): Promise<Uint8Array> {
  const chunks = chunksOf(bytes)
  const header = chunks?.find((c) => c.name === "IHDR")?.data
  if (!chunks || !header || header.length < 13) return bytes
  const view = new DataView(header.buffer, header.byteOffset, 13)
  const width = view.getUint32(0)
  const height = view.getUint32(4)
  // 8-bit RGBA, deflate, adaptive filters, no interlace.
  if (header[8] !== 8 || header[9] !== 6 || header[12] !== 0) return bytes
  const idat = chunks.filter((c) => c.name === "IDAT").map((c) => c.data)
  const joined = new Uint8Array(idat.reduce((n, d) => n + d.length, 0))
  let at = 0
  for (const data of idat) {
    joined.set(data, at)
    at += data.length
  }
  const raw = await through(joined, new DecompressionStream("deflate")).catch(
    () => null
  )
  if (raw?.length !== (width * 4 + 1) * height) return bytes
  const pixels = unfilter(raw, width, height)
  let [left, top, right, bottom] = [width, height, -1, -1]
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((pixels[(y * width + x) * 4 + 3] ?? 0) <= SEEN) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  if (right < 0) return bytes
  const pad = Math.round(MARGIN * Math.max(right - left + 1, bottom - top + 1))
  left = Math.max(0, left - pad)
  top = Math.max(0, top - pad)
  right = Math.min(width - 1, right + pad)
  bottom = Math.min(height - 1, bottom + pad)
  const w = right - left + 1
  const h = bottom - top + 1
  if (w === width && h === height) return bytes
  const cut = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    const from = ((top + y) * width + left) * 4
    cut.set(pixels.subarray(from, from + w * 4), y * w * 4)
  }
  return await encodeRgba(cut, w, h)
}
