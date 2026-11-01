/**
 * The markdown a prose block may hold: h2 and h3, paragraphs, bulleted and
 * numbered lists, bold, italic, links and pipe tables. Anything else is text.
 * It parses to a tree that src/layouts/Markdown.astro renders through Astro,
 * which escapes every text node, so a tag typed into a document shows as the
 * tag and nothing here builds HTML. A link goes only to a page of the site,
 * an anchor, the web, an email or a phone; any other stays as typed.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] }

export type MarkdownBlock =
  | { type: "heading"; level: 2 | 3; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "table"; head: Inline[][]; rows: Inline[][][] }

/** The same rule as the page document's SafeHref. */
export const SAFE_HREF = /^(?:\/(?!\/)|#|https?:\/\/|mailto:|tel:)\S*$/

const ESCAPABLE = /[\\`*_[\]()#+\-.!|>]/
const WORD = /[\p{L}\p{N}]/u

/** Where an emphasis opened at `from - 1` with `mark` closes, or -1. */
function closing(source: string, from: number, mark: string): number {
  for (let j = from; j < source.length; j++) {
    if (source[j] === "\\") {
      j++
      continue
    }
    if (
      source[j] === mark &&
      j > from &&
      !/\s/.test(source[j - 1] ?? "") &&
      (mark === "*" ? source[j + 1] !== "*" : !WORD.test(source[j + 1] ?? ""))
    )
      return j
  }
  return -1
}

export function inline(source: string, links = true): Inline[] {
  const out: Inline[] = []
  let text = ""
  const flush = () => {
    if (text) out.push({ type: "text", text })
    text = ""
  }
  let i = 0
  while (i < source.length) {
    const c = source[i] as string
    const next = source[i + 1] ?? ""
    if (c === "\\" && ESCAPABLE.test(next)) {
      text += next
      i += 2
      continue
    }
    if (c === "*" && next === "*") {
      const end = source.indexOf("**", i + 2)
      if (end > i + 2) {
        flush()
        out.push({
          type: "strong",
          children: inline(source.slice(i + 2, end), links),
        })
        i = end + 2
        continue
      }
    }
    if (
      (c === "*" || c === "_") &&
      next &&
      !/\s/.test(next) &&
      !(c === "_" && WORD.test(source[i - 1] ?? ""))
    ) {
      const end = closing(source, i + 1, c)
      if (end > 0) {
        flush()
        out.push({
          type: "em",
          children: inline(source.slice(i + 1, end), links),
        })
        i = end + 1
        continue
      }
    }
    if (c === "[" && links) {
      const link = /^\[([^\]]+)\]\(([^()\s]+)\)/.exec(source.slice(i))
      if (link && SAFE_HREF.test(link[2] as string)) {
        flush()
        out.push({
          type: "link",
          href: link[2] as string,
          children: inline(link[1] as string, false),
        })
        i += link[0].length
        continue
      }
    }
    text += c
    i++
  }
  flush()
  return out
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const ITEM = /^\s*(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/
const RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/

/** A table row's cells: the outer pipes dropped, split on a pipe no backslash escapes. */
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim())

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n")
  const out: MarkdownBlock[] = []
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length > 0)
      out.push({ type: "paragraph", children: inline(paragraph.join(" ")) })
    paragraph = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    if (!line.trim()) {
      flush()
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      out.push({
        type: "heading",
        level: (heading[1] as string).length >= 3 ? 3 : 2,
        children: inline(heading[2] as string),
      })
      continue
    }
    if (line.includes("|") && RULE.test(lines[i + 1] ?? "")) {
      flush()
      const head = cells(line)
      const rows: Inline[][][] = []
      for (
        i += 2;
        i < lines.length && (lines[i] as string).includes("|");
        i++
      ) {
        const row = cells(lines[i] as string)
        rows.push(head.map((_, c) => inline(row[c] ?? "")))
      }
      i--
      out.push({ type: "table", head: head.map((c) => inline(c)), rows })
      continue
    }
    const item = ITEM.exec(line)
    if (item) {
      flush()
      const ordered = item[2] !== undefined
      const items: string[] = [item[3] as string]
      for (i++; i < lines.length; i++) {
        const more = lines[i] as string
        const next = ITEM.exec(more)
        if (next && (next[2] !== undefined) === ordered)
          items.push(next[3] as string)
        else if (more.trim() && /^\s+/.test(more) && !next)
          items[items.length - 1] += ` ${more.trim()}`
        else break
      }
      i--
      out.push({
        type: "list",
        ordered,
        items: items.map((text) => inline(text)),
      })
      continue
    }
    paragraph.push(line.trim())
  }
  flush()
  return out
}

/** The words a reader sees, for a check that counts them. */
export const plainOf = (nodes: Inline[]): string =>
  nodes.map((n) => (n.type === "text" ? n.text : plainOf(n.children))).join("")
