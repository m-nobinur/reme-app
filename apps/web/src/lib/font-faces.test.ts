import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { previewFaces } from "@workspace/ui/lib/font-faces"
import { expect, test } from "vitest"

// The tray's preview faces are static files under public/, not imports, so a
// renamed or missing file would only show as a silent fallback font. This
// fails instead: every face the tray asks for must be on disk.
test("every preview face the tray asks for is a file in public/", () => {
  const publicDir = fileURLToPath(new URL("../../public", import.meta.url))
  const faces = previewFaces()
  expect(faces).toHaveLength(14)
  for (const { url } of faces) {
    expect(url).toMatch(/^\/fonts\/[a-z-]+-latin-\d{3}-normal\.woff2$/)
    expect(existsSync(join(publicDir, url))).toBe(true)
  }
})
