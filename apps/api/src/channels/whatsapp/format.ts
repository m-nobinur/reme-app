/** WhatsApp's limit on one text message's body. */
export const TEXT_MAX = 4096

const INVISIBLE = /[​‌‎‏⁠-⁤﻿]/g
const ODD_SPACE = /[  -   　]/g

function stash(text: string, pattern: RegExp, tag: string) {
  const saved: string[] = []
  const out = text.replace(pattern, (m) => {
    saved.push(m)
    return `\u0000${tag}${saved.length - 1}\u0000`
  })
  return { out, saved }
}

/**
 * Markdown as WhatsApp writes it (`*bold*`, `_italic_`, `~strike~`), after
 * Hermes `whatsapp_common.py:268-286`: code is left as written, headings
 * become bold lines and links show their address.
 */
export function whatsAppText(markdown: string): string {
  const clean = markdown.replace(INVISIBLE, "").replace(ODD_SPACE, " ")
  const fences = stash(clean, /```[\s\S]*?```/g, "F")
  const codes = stash(fences.out, /`[^`\n]+`/g, "C")
  let out = codes.out
    .replace(/(?<!\*)\*(?!\s|\*)([^*\n]*?\S[^*\n]*?)\*(?!\*)/g, "_$1_")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "*$1*")
    .replace(/~~(.+?)~~/g, "~$1~")
    .replace(/^#{1,6}\s+(.+)$/gm, (_, heading: string) => {
      let inner = heading.trim()
      while (inner.length > 1 && inner.startsWith("*") && inner.endsWith("*")) {
        inner = inner.slice(1, -1).trim()
      }
      return `*${inner}*`
    })
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
  for (const [tag, saved] of [
    ["C", codes.saved],
    ["F", fences.saved],
  ] as const) {
    saved.forEach((original, i) => {
      out = out.replace(`\u0000${tag}${i}\u0000`, () => original)
    })
  }
  return out
}

/**
 * The reply in as few messages as fit, cut at a paragraph, then a line,
 * then a space. A code fence cut in two is closed and reopened.
 */
export function splitText(text: string, max = TEXT_MAX): string[] {
  const limit = max - 4
  const parts: string[] = []
  let rest = text
  while (rest.length > max) {
    let cut = -1
    for (const at of ["\n\n", "\n", " "]) {
      cut = rest.lastIndexOf(at, limit)
      if (cut > limit / 2) break
    }
    if (cut <= limit / 2) cut = limit
    let head = rest.slice(0, cut).trimEnd()
    rest = rest.slice(cut).trimStart()
    if ((head.match(/```/g)?.length ?? 0) % 2 === 1) {
      head += "\n```"
      rest = `\`\`\`\n${rest}`
    }
    parts.push(head)
  }
  if (rest) parts.push(rest)
  return parts
}
