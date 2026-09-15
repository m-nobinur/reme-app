import { parse } from "parse5"

/**
 * One built page as the gates read it: what a visitor can read, where it
 * links, and the structured data it declares, each with the node it sits in.
 * Parsed with a WHATWG-compliant parser, so the gates see the document a
 * browser builds, not what a regular expression guesses at (ADR-032).
 */
export type Located = { value: string; node: string }
export type Page = {
  file: string
  texts: Located[]
  links: Located[]
  jsonLd: Located[]
}

type TreeNode = {
  nodeName: string
  tagName?: string
  value?: string
  attrs?: { name: string; value: string }[]
  childNodes?: TreeNode[]
  content?: { childNodes?: TreeNode[] }
}

/** Attributes whose text reaches a visitor or a crawler, and so can carry a claim. */
const CLAIM_ATTRIBUTES = new Set([
  "content",
  "title",
  "alt",
  "aria-label",
  "placeholder",
])
const LINK_ATTRIBUTES = new Set(["href", "src"])
/** Elements whose text is not page copy. JSON-LD scripts are read separately. */
const SILENT = new Set(["script", "style", "noscript", "template"])

export function parsePage(file: string, html: string): Page {
  const page: Page = { file, texts: [], links: [], jsonLd: [] }
  const walk = (node: TreeNode, path: string) => {
    const children = node.childNodes ?? node.content?.childNodes ?? []
    const counts = new Map<string, number>()
    for (const child of children) {
      if (child.nodeName === "#text") {
        const value = (child.value ?? "").trim()
        if (value && !SILENT.has(node.tagName ?? ""))
          page.texts.push({ value, node: path })
        continue
      }
      if (!child.tagName) continue
      const seen = counts.get(child.tagName) ?? 0
      counts.set(child.tagName, seen + 1)
      const step = seen === 0 ? child.tagName : `${child.tagName}[${seen}]`
      const childPath = path ? `${path}>${step}` : step
      for (const attr of child.attrs ?? []) {
        if (LINK_ATTRIBUTES.has(attr.name))
          page.links.push({ value: attr.value, node: childPath })
        if (CLAIM_ATTRIBUTES.has(attr.name) && attr.value.trim()) {
          page.texts.push({
            value: attr.value.trim(),
            node: `${childPath}@${attr.name}`,
          })
        }
      }
      const type = child.attrs?.find((a) => a.name === "type")?.value
      if (child.tagName === "script" && type === "application/ld+json") {
        const raw = (child.childNodes ?? []).map((c) => c.value ?? "").join("")
        page.jsonLd.push({ value: raw, node: childPath })
      }
      walk(child, childPath)
    }
  }
  walk(parse(html) as unknown as TreeNode, "")
  return page
}

/**
 * The file a request path names under a revision, or null: only what the
 * manifest lists resolves (`/` to `index.html`, `/contact/` and `/contact` to
 * `contact/index.html`). The links gate, the console preview and the router
 * read paths the same way.
 */
export function resolveSitePath(
  pathname: string,
  files: Record<string, string>
): string | null {
  let path: string
  try {
    path = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (path.includes("\0") || path.split("/").includes("..")) return null
  const trimmed = path.replace(/^\/+/, "")
  const candidates =
    trimmed === "" || trimmed.endsWith("/")
      ? [`${trimmed}index.html`]
      : [trimmed, `${trimmed}/index.html`]
  return candidates.find((file) => Object.hasOwn(files, file)) ?? null
}
