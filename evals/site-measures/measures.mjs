import { createRequire } from "node:module"
import { repeatedSentences } from "@workspace/gates"
import { hashDistance, pairs, sequenceDistance } from "../variety/measures.mjs"

// shortcut: parse5 is the gates' dependency, not the root's; resolved from
// there so the evals add no package. Add it at the root if evals grow.
const { parse } = createRequire(
  new URL("../../packages/gates/package.json", import.meta.url)
)("parse5")

/**
 * Design §6's site measures, pure functions over a build already read from
 * disk (../site-measures.mjs does the reading): how rich, how repetitive and
 * how well outlined a built site is, how far its layout moved from its
 * pack's starting order, how distinct its photos are, and the one-FAQ,
 * page-per-offering and services-table checks. `changeFidelity` scores a
 * change against its brief, for stream 2C's change-request evals.
 */

const SKIPPED = new Set(["script", "style", "template", "noscript"])

const attr = (node, name) => node.attrs?.find((a) => a.name === name)?.value

const childrenOf = (node) => node.childNodes ?? node.content?.childNodes ?? []

const textOf = (node) =>
  node.tagName && SKIPPED.has(node.tagName)
    ? ""
    : node.nodeName === "#text"
      ? (node.value ?? "")
      : childrenOf(node).map(textOf).join(" ")

/** Lowercase words, letters and digits only, as the copy gate counts them. */
export const wordsOf = (text) =>
  text
    .toLowerCase()
    .replace(/[’']/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

const FILLER = new Set(
  "a an and are at by for from how in is it of on or our the to us we what when where who why with you your".split(
    " "
  )
)
const stemsOf = (text) =>
  new Set(
    wordsOf(text)
      .filter((w) => !FILLER.has(w))
      .map((w) => w.slice(0, 5))
  )

/**
 * One page as the measures read it: every heading in document order, the
 * words of <main> in runs under each h2 (`intro` before the first), its
 * JSON-LD types, whether <main> holds a table, and the raster images it
 * shows, by src.
 */
export function readPage(html) {
  const out = {
    headings: [],
    runs: [{ heading: "", text: [] }],
    types: [],
    table: false,
    images: [],
  }
  const walk = (node, inMain) => {
    for (const child of childrenOf(node)) {
      if (child.nodeName === "#text") {
        if (inMain) out.runs.at(-1).text.push(child.value ?? "")
        continue
      }
      const tag = child.tagName
      if (!tag) continue
      if (tag === "script" && attr(child, "type") === "application/ld+json") {
        try {
          const body = childrenOf(child)
            .map((c) => c.value ?? "")
            .join("")
          for (const item of [JSON.parse(body)].flat())
            out.types.push(...[item?.["@type"]].flat().filter(Boolean))
        } catch {
          // Unparsable JSON-LD is the structured data gate's to fail.
        }
        continue
      }
      if (SKIPPED.has(tag)) continue
      const main = inMain || tag === "main"
      const level = /^h([1-6])$/.exec(tag)?.[1]
      if (level) {
        const text = textOf(child).replace(/\s+/g, " ").trim()
        out.headings.push({ level: Number(level), text })
        if (main && level === "2") {
          out.runs.push({ heading: text, text: [] })
          continue
        }
      }
      if (main && tag === "table") out.table = true
      if (tag === "img") {
        const src = attr(child, "src") ?? ""
        if (src && !/\.svg(?:$|\?)/.test(src)) out.images.push(src)
      }
      walk(child, main)
    }
  }
  walk(parse(html), false)
  return {
    ...out,
    runs: out.runs.map((r) => ({
      heading: r.heading,
      words: wordsOf(r.text.join(" ")).length,
    })),
  }
}

/**
 * The outline's faults: a page without exactly one h1, and each step down
 * that skips a level (an h2 straight to an h4). Going back up any number of
 * levels is how an outline closes a part, so it is never a fault.
 */
export function outlineProblems(file, headings) {
  const found = []
  const h1s = headings.filter((h) => h.level === 1).length
  if (h1s !== 1) found.push(`${file}: ${h1s} h1s`)
  let last = 0
  for (const h of headings) {
    if (h.level > last + 1)
      found.push(`${file}: h${last} to h${h.level} at "${h.text.slice(0, 60)}"`)
    last = h.level
  }
  return found
}

/** A built file as the page it is: `services/<slug>/index.html` is a service's. */
export function pageOf(file) {
  if (file === "index.html") return { page: "home" }
  const slug = /^services\/([^/]+)\/index\.html$/.exec(file)?.[1]
  if (slug) return { page: "service", slug }
  const name = /^([^/]+)\/index\.html$/.exec(file)?.[1]
  return name ? { page: name.replace(/-/g, "_") } : null
}

/** Whether a heading is one of the plan's: half its significant stems shared with an outline heading or a topic. */
const planned = (heading, entry) => {
  const own = stemsOf(heading)
  if (own.size === 0) return false
  return [...entry.topics, ...entry.outline.map((o) => o.heading)].some(
    (line) => {
      const theirs = stemsOf(line)
      const shared = [...own].filter((s) => theirs.has(s)).length
      return shared / Math.min(own.size, theirs.size || 1) >= 0.5
    }
  )
}

const mean = (xs) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
const round = (x, places = 3) =>
  x === null ? null : Math.round(x * 10 ** places) / 10 ** places

/** Two photos this close (of 1) read as one scene. */
export const NEAR_PHOTO = 0.15

/**
 * Every measure of one built site.
 * - `pages`: each indexed built page, `{file, html}`; a noindex page (the
 *   404) is left out.
 * - `layout`: each page's sections in order, `{kind, variant?}`, and
 *   `packOrder` the pack's starting order the build began from.
 * - `services`: the named services as `{name, slug}`, in card order.
 * - `content`: the Blueprint's content plan, or null for a build without one.
 * - `photos`: each distinct photo the pages show, `{src, hash}` (a dhash).
 */
export function measureSite({
  pages,
  layout,
  packOrder,
  services,
  content,
  photos,
}) {
  const read = pages.map((p) => ({ ...p, ...readPage(p.html) }))
  const repeats = repeatedSentences(pages)
  const repeatedWords = new Map()
  for (const { sentence, files } of repeats)
    for (const file of files.slice(1))
      repeatedWords.set(
        file,
        (repeatedWords.get(file) ?? 0) + sentence.split(" ").length
      )
  const perPage = read.map((p) => {
    const words = p.runs.reduce((n, r) => n + r.words, 0)
    const at = pageOf(p.file)
    const offering =
      at?.page === "service"
        ? services.findIndex((s) => s.slug === at.slug) + 1
        : 0
    const entry = content?.find(
      (c) => c.page === at?.page && c.offering === offering
    )
    return {
      file: p.file,
      words,
      ownWords: words - (repeatedWords.get(p.file) ?? 0),
      topicWords: entry
        ? p.runs
            .filter((r) => r.heading && planned(r.heading, entry))
            .reduce((n, r) => n + r.words, 0)
        : null,
    }
  })
  const outline = read.flatMap((p) => outlineProblems(p.file, p.headings))
  const kinds = (sections) => (sections ?? []).map((s) => s.kind)
  const distances = Object.keys(packOrder ?? {})
    .filter((page) => layout?.[page])
    .map((page) =>
      sequenceDistance(kinds(layout[page]), kinds(packOrder[page]))
    )
  const photoPairs = pairs(photos).map(([a, b]) => hashDistance(a.hash, b.hash))
  const faqPages = read.filter((p) => p.types.includes("FAQPage")).length
  const built = new Set(
    read.flatMap((p) => {
      const at = pageOf(p.file)
      return at?.page === "service" ? [at.slug] : []
    })
  )
  const servicesPage = read.find((p) => p.file === "services/index.html")
  const total = perPage.reduce((n, p) => n + p.words, 0)
  const topic = perPage.filter((p) => p.topicWords !== null)
  return {
    pages: read.length,
    richness: {
      words: total,
      wordsPerPage: round(total / (read.length || 1), 1),
      ownWords: perPage.reduce((n, p) => n + p.ownWords, 0),
      topicWords:
        topic.length > 0 ? topic.reduce((n, p) => n + p.topicWords, 0) : null,
      perPage,
    },
    duplication: {
      sentences: repeats.length,
      extraCopies: repeats.reduce((n, r) => n + r.files.length - 1, 0),
      examples: repeats.slice(0, 5),
    },
    outline: { valid: outline.length === 0, problems: outline },
    layoutDistance: round(mean(distances)),
    photos: {
      shown: photos.length,
      nearPairs: photoPairs.filter((d) => d < NEAR_PHOTO).length,
      meanDistance: round(mean(photoPairs)),
    },
    faqPages,
    oneFaqPage: faqPages <= 1,
    offerings: {
      services: services.length,
      pages: services.filter((s) => built.has(s.slug)).length,
      everyOne: services.every((s) => built.has(s.slug)),
    },
    servicesTable:
      services.length > 1 && servicesPage ? servicesPage.table : null,
  }
}

const isObject = (v) => v !== null && typeof v === "object"
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** Every string a value holds, keys aside. */
const stringsOf = (value) =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(stringsOf)
      : isObject(value)
        ? Object.values(value).flatMap(stringsOf)
        : []

/** Each page's parts by name: `home.json`, `home.json#faq`, `home.json#faq/faq-questions`. */
function partsOf(documents) {
  const parts = new Map()
  for (const [file, doc] of Object.entries(documents)) {
    const { sections = [], ...page } = doc
    parts.set(file, page)
    for (const { blocks = [], ...section } of sections) {
      parts.set(`${file}#${section.id}`, section)
      for (const block of blocks)
        parts.set(`${file}#${section.id}/${block.id}`, block)
    }
  }
  return parts
}

/**
 * A change against its brief (design §6, change fidelity), over the page
 * documents before and after it: every part it did not target is as it was
 * (a target covers what it names and every part under it), every piece of
 * the owner's own text is in the documents word for word, and every
 * acceptance check the caller ran (`{check, passed}`, a judge's or code's)
 * passed. `targets` name parts as `partsOf` does.
 */
export function changeFidelity({
  before,
  after,
  targets,
  ownerText = [],
  acceptance = [],
}) {
  const covered = (name) =>
    targets.some(
      (t) => name === t || name.startsWith(`${t}#`) || name.startsWith(`${t}/`)
    )
  const was = partsOf(before)
  const now = partsOf(after)
  const touched = [...new Set([...was.keys(), ...now.keys()])].filter(
    (name) => !covered(name) && !same(was.get(name), now.get(name))
  )
  const said = stringsOf(after).join("\n")
  const missing = ownerText.filter((text) => !said.includes(text))
  const failed = acceptance.filter((a) => !a.passed).map((a) => a.check)
  return {
    passed: touched.length === 0 && missing.length === 0 && failed.length === 0,
    untargetedChanges: touched,
    ownerTextMissing: missing,
    failedChecks: failed,
  }
}
