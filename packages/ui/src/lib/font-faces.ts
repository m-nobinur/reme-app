import { FONT_PAIRS } from "@workspace/contracts"

/**
 * The faces the question tray sets each font pair in: the display face at its
 * first weight and the body at regular, the only two a preview draws. The
 * files are the starter's latin woff2, copied to apps/web/public/fonts, so
 * they are static assets served under the CSP's font-src 'self'.
 */
export type PreviewFace = { family: string; weight: number; url: string }

const slug = (family: string) => family.toLowerCase().replaceAll(" ", "-")

export function previewFaces(): PreviewFace[] {
  const faces = new Map<string, PreviewFace>()
  for (const { display, body } of FONT_PAIRS) {
    const wanted = [
      [display.family, display.weights[0] ?? 400],
      [body.family, 400],
    ] as const
    for (const [family, weight] of wanted) {
      const key = `${family}/${weight}`
      if (faces.has(key)) continue
      const url = `/fonts/${slug(family)}-latin-${weight}-normal.woff2`
      faces.set(key, { family, weight, url })
    }
  }
  return [...faces.values()]
}
