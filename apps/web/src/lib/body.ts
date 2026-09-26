/**
 * A request body as text, or null when it is larger than `cap` bytes. The
 * declared length is checked first, and the bytes are counted as they
 * arrive, so a chunked body with no length cannot run past the cap either.
 */
export async function readCapped(
  request: Request,
  cap: number
): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > cap) return null
  const reader = request.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > cap) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}
