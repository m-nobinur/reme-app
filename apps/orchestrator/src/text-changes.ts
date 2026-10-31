import { type CompletionReport, DeploymentManifest } from "@workspace/contracts"
import { assignments, eq, type OrgScopedDb, type Tenancy } from "@workspace/db"
import { parsePage } from "@workspace/gates"
import { reviseSource } from "./revise.ts"

/**
 * What a revision changed on the built pages, read by code from the old and
 * new HTML and never by the model. The report holds
 * it beside the Developer's own summary, so an owner asking "what was it
 * before?" is answered from the pages, not from a model's memory of its edit.
 */

export type TextChanges = Pick<
  CompletionReport,
  "text_changes" | "text_changes_left"
>

const MAX_PAIRS = 8
const MAX_PAGES = 5
const MAX_CHARS = 300
/** Pages read for one record, and the largest page read. Past either, nothing is recorded. */
const MAX_READ = 40
const MAX_BYTES = 1_000_000

type Pair = { before: string; after: string }
type Block = { node: string; text: string }

/** At most 300 characters, cut at a word, with an ellipsis where text was dropped. */
export function cut(text: string): string {
  if (text.length <= MAX_CHARS) return text
  const head = text.slice(0, MAX_CHARS - 1)
  const space = head.lastIndexOf(" ")
  return `${(space > 0 ? head.slice(0, space) : head).trimEnd()}…`
}

/** The page's visible text, one block per element: what a visitor reads, not attributes or scripts. */
function blocks(html: string): Block[] {
  const byNode = new Map<string, string[]>()
  for (const { value, node } of parsePage("page.html", html).texts)
    if (!node.includes("@"))
      byNode.set(node, [...(byNode.get(node) ?? []), value])
  return [...byNode].map(([node, parts]) => ({
    node,
    text: parts.join(" ").replace(/\s+/g, " ").trim(),
  }))
}

/** The blocks of `from` with no equal text left in `pool`, so a moved section is not a change. */
function unmatched(from: Block[], pool: Block[]): Block[] {
  const left = new Map<string, number>()
  for (const { text } of pool) left.set(text, (left.get(text) ?? 0) + 1)
  return from.filter(({ text }) => {
    const n = left.get(text) ?? 0
    if (n > 0) left.set(text, n - 1)
    return n === 0
  })
}

/**
 * The text that differs between two versions of one page. What is left once
 * equal blocks cancel is paired by element path, so a rewritten heading is
 * one pair; a block with no partner is an addition (`before` "") or a
 * removal (`after` "").
 */
export function textPairs(before: string, after: string): Pair[] {
  const old = blocks(before)
  const now = blocks(after)
  const removed = unmatched(old, now)
  const pairs: Pair[] = []
  for (const added of unmatched(now, old)) {
    const at = removed.findIndex((block) => block.node === added.node)
    const [partner] = at < 0 ? [] : removed.splice(at, 1)
    pairs.push({ before: partner?.text ?? "", after: added.text })
  }
  for (const gone of removed) pairs.push({ before: gone.text, after: "" })
  return pairs
}

/** `index.html` is `/`, `about/index.html` is `/about/`: the route a visitor types. */
const routeOf = (file: string) => `/${file.replace(/index\.html$/, "")}`

/**
 * The pairs across pages: one edit repeated on every page (a header or
 * footer) is one pair naming up to five of them, capped at eight pairs with
 * the rest counted. An empty list says the pages were compared and no text
 * differs.
 */
export function collect(
  pages: readonly { file: string; before: string; after: string }[]
): TextChanges {
  const merged = new Map<
    string,
    NonNullable<TextChanges["text_changes"]>[number]
  >()
  for (const page of pages) {
    const route = routeOf(page.file)
    for (const pair of textPairs(page.before, page.after)) {
      const before = cut(pair.before)
      const after = cut(pair.after)
      const key = `${before}\u0000${after}`
      const entry = merged.get(key) ?? { before, after, pages: [] }
      if (entry.pages.length < MAX_PAGES) entry.pages.push(route)
      merged.set(key, entry)
    }
  }
  const all = [...merged.values()]
  return {
    text_changes: all.slice(0, MAX_PAIRS),
    ...(all.length > MAX_PAIRS && {
      text_changes_left: all.length - MAX_PAIRS,
    }),
  }
}

/**
 * The revision a change started from: what the site served, or the draft the
 * owner asked it on. A first build has none, so it records nothing.
 */
export async function changeBase(
  db: OrgScopedDb,
  ids: { orgId: string; assignmentId: string }
): Promise<string | null> {
  const [row] = await db
    .select({ kind: assignments.kind })
    .from(assignments)
    .where(eq(assignments.id, ids.assignmentId))
  if (row?.kind !== "site.revise") return null
  return (await reviseSource(db, ids))?.revision_id ?? null
}

type Sites = {
  get: (
    key: string
  ) => Promise<{ size?: number; text: () => Promise<string> } | null>
}

/**
 * Compare the pages that differ between the base revision and the new one.
 * `{}` when there is nothing to compare against: a first build, or a base
 * whose files retention has swept. Never throws; a record that could not be
 * read must not fail the build it describes.
 */
export async function recordTextChanges(input: {
  kit: Tenancy
  sites: Sites
  orgId: string
  assignmentId: string
  /** The new revision's R2 prefix. */
  prefix: string
}): Promise<TextChanges> {
  const { kit, sites, orgId, prefix } = input
  try {
    const base = await kit.withOrg({ orgId }, (db) => changeBase(db, input))
    if (!base) return {}
    const root = `sites/${orgId}/${base}/`
    const manifest = async (at: string) => {
      const object = await sites.get(`${at}manifest.json`)
      return object
        ? DeploymentManifest.parse(JSON.parse(await object.text())).files
        : null
    }
    const [was, now] = await Promise.all([manifest(root), manifest(prefix)])
    if (!was || !now) return {}
    // A page in only one of the two is a page added or removed, not text changed.
    const files = Object.keys(now)
      .filter((f) => f.endsWith(".html") && was[f] && was[f] !== now[f])
      .sort()
    // A rewrite of the whole site is not an edit worth a record, and reading it would cost more than the record is worth.
    if (files.length > MAX_READ) return {}
    const pages = await Promise.all(
      files.map(async (file) => {
        const [before, after] = await Promise.all([
          sites.get(`${root}dist/${file}`),
          sites.get(`${prefix}dist/${file}`),
        ])
        const sized = (object: typeof before) =>
          (object?.size ?? 0) <= MAX_BYTES
        return before && after && sized(before) && sized(after)
          ? { file, before: await before.text(), after: await after.text() }
          : null
      })
    )
    const read = pages.filter((page) => page !== null)
    return read.length === pages.length ? collect(read) : {}
  } catch {
    return {}
  }
}
