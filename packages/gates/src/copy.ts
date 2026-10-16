import type { FactRecord, GateResult } from "@workspace/contracts"
import { parse } from "parse5"

/**
 * The copy gate: the site reads as written for this business, not as a
 * template. It runs on a planned first build only (a revise changes what the
 * owner asked and must not fail on copy it did not touch) and fails on
 *
 * - an h1 or h2 that repeats another anywhere on the site, near-duplicates
 *   included: the same words in another order or form ("Garden services" and
 *   "Our garden service");
 * - an h1 or h2 that is a stock label ("Our services", "Why choose us"),
 *   which may only be an eyebrow;
 * - two pages with the same title, or a process step whose words another
 *   step on the site already uses;
 * - a section's copy under its minimum word count;
 * - copy that talks about the writer's own inputs ("our facts don't say"),
 *   anywhere a visitor or a search engine reads it, JSON-LD included;
 * - a town in the service-area chips, or a near-miss spelling of one in any
 *   copy, that the service-area fact does not name exactly;
 * - a word in any copy that is a near-miss of one of the business's own terms
 *   (a service name, the trade, a noun in the facts' descriptions): "conservative
 *   roofs" for "conservatory roofs";
 * - a service page without its "what is included" or "who it suits" block,
 *   an about page without its principles or its visit steps, or a contact
 *   page without its note on what to send;
 * - a page title outside the writer's 50 to 60 characters, or a description
 *   outside its 140 to 165.
 *
 * The starter marks what is checked with `data-copy="<kind>"` on the
 * elements whose words are counted. Every h1 and h2 inside <main> is
 * compared, each page's closing band included; headings outside it (the
 * footer's) are site chrome and are not read.
 */

/**
 * The copy brief per section, in words: what the writer aims for and what
 * the gate fails under. The gate's minimum sits below the aim so a line a few
 * words short is not a repair round; the writer is told the aim.
 */
export const COPY_WORDS = {
  hero_lede: { aim: [25, 55], min: 15 },
  service_body: { aim: [25, 45], min: 15 },
  service_detail: { aim: [60, 100], min: 36 },
  step_body: { aim: [20, 35], min: 12 },
  faq_answer: { aim: [40, 90], min: 36 },
  // The about page's two paragraphs together, the brief's 120 to 200 words.
  about_body: { aim: [120, 200], min: 100 },
  // An about page principle: how the work is done, title and body.
  approach_body: { aim: [25, 45], min: 18 },
  // The about page's record: a short paragraph beside the proof items.
  proof_body: { aim: [30, 60], min: 20 },
  // The services page's "not sure which you need" paragraph.
  services_help: { aim: [40, 80], min: 30 },
  // The contact page's note on what a message should say.
  contact_body: { aim: [25, 60], min: 18 },
} as const satisfies Record<
  string,
  { aim: readonly [number, number]; min: number }
>

export type CopyKind = keyof typeof COPY_WORDS

/** What a section's copy is, by the starter's `data-copy` value, for the messages. */
const LABEL: Record<CopyKind, string> = {
  hero_lede: "the home hero's subhead (homeIntro)",
  service_body: "a service card (serviceNBody)",
  service_detail: "a service page's intro (serviceNDetail)",
  step_body: "a process step (stepNBody)",
  faq_answer:
    "an FAQ answer (faqNAnswer, or serviceNFaqMAnswer on a service page)",
  about_body: "the about page's body (overviewBody and audienceBody together)",
  approach_body: "an about page principle (approachNBody)",
  proof_body: "the about page's record (proofBody)",
  services_help: "the services page's helper (servicesHelpBody)",
  contact_body: "the contact page's note on what to send (contactIncludeBody)",
}

/** A page's meta description, in characters: the brief's 140 to 160 with a few over. */
export const DESCRIPTION_CHARS = { min: 140, max: 165 }

/** A page's title, in characters: exactly the brief's range, so a long one fails the first time. */
export const TITLE_CHARS = { min: 50, max: 60 }

/**
 * Copy that talks about what the writer was told rather than to the visitor.
 * Narrow on purpose: a bare "the owner" or "isn't in" is ordinary English on a
 * cleaning site ("the owner of the property", "if the oven isn't in use").
 */
const LEAKS = [
  /\b(?:our|the|these) facts\b/gi,
  /\bfacts (?:don[’']?t|do not|doesn[’']?t|does not|didn[’']?t|say|state|give)\b/gi,
  /\b(?:we|i) (?:don[’']?t|do not) know\b/gi,
  /\b(?:doesn[’']?t|does not|don[’']?t|do not) (?:say|state|specify) (?:here|whether|how|if)\b/gi,
  /\b(?:not|isn[’']?t|is not|aren[’']?t|are not|wasn[’']?t|was not) (?:been )?(?:set out|stated|specified|given|mentioned|provided)\b/gi,
  /\b(?:isn[’']?t|is not|aren[’']?t|are not) in (?:our|the|these) (?:facts|notes|brief|information|details)\b/gi,
  /\bno (?:further |more |other )?information\b/gi,
  /\bthe (?:business )?owner (?:has|hasn[’']?t|have|haven[’']?t|did|didn[’']?t|says|said|gave|told|stated|mentioned|provided)\b/gi,
  /\b(?:our|the) (?:notes|brief)\b/gi,
  /\bas an ai\b|\blanguage model\b/gi,
]

/** Headings that fit any business: an eyebrow may say them, an h1 or h2 may not. */
export const STOCK_HEADINGS = [
  "about",
  "about us",
  "areas we cover",
  "common questions",
  "contact",
  "contact us",
  "everything we offer",
  "faq",
  "faqs",
  "frequently asked questions",
  "gallery",
  "get a quote",
  "get in touch",
  "how it works",
  "how we work",
  "our process",
  "our services",
  "our story",
  "our team",
  "our work",
  "process",
  "questions",
  "request a quote",
  "reviews",
  "service area",
  "services",
  "testimonials",
  "welcome",
  "what clients say",
  "what our clients say",
  "what sets us apart",
  "what we do",
  "where we work",
  "who we work with",
  "why choose us",
  "why us",
]

/** Words that do not make one heading different from another. */
const FILLER = new Set(
  "a an and are at by for from how in is it of on or our the to us we what when where who why with you your".split(
    " "
  )
)

export type CopyFinding = {
  file: string
  node: string
  problem:
    | "duplicate"
    | "stock"
    | "short"
    | "leak"
    | "town"
    | "term"
    | "missing"
  text: string
  detail: string
}

type TreeNode = {
  nodeName: string
  tagName?: string
  value?: string
  attrs?: { name: string; value: string }[]
  childNodes?: TreeNode[]
  content?: { childNodes?: TreeNode[] }
}

const attr = (node: TreeNode, name: string) =>
  node.attrs?.find((a) => a.name === name)?.value

const textOf = (node: TreeNode): string =>
  node.nodeName === "#text"
    ? (node.value ?? "")
    : (node.childNodes ?? []).map(textOf).join("")

const squash = (text: string) => text.replace(/\s+/g, " ").trim()

/** Lowercase words, letters and digits only. */
const wordsOf = (text: string) =>
  text
    .toLowerCase()
    .replace(/[’']/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

const plainText = (text: string) => wordsOf(text).join(" ")

/** A heading's significant words as stems (the claims gate's five letters). */
const stemsOf = (text: string) => {
  const words = wordsOf(text)
  const kept = words.filter((w) => !FILLER.has(w))
  return new Set((kept.length > 0 ? kept : words).map((w) => w.slice(0, 5)))
}

/**
 * Two headings are one when three quarters of their stems are shared,
 * whatever the order: "Garden work for homes across Bristol" and "Bristol
 * homes: garden work" are one heading, "Garden design" and "Garden design
 * for Bath homes" are two.
 */
export const NEAR = 0.75
const alike = (a: Set<string>, b: Set<string>) => {
  const shared = [...a].filter((s) => b.has(s)).length
  return shared / (a.size + b.size - shared) >= NEAR
}

type Read = {
  title: string
  headings: { tag: string; text: string; node: string }[]
  copy: { kind: CopyKind; text: string; node: string }[]
  /** Every `data-copy` value on the page, whether or not it has a word range. */
  marks: Set<string>
  /** The area chips' towns. */
  towns: { text: string; node: string }[]
  /** Everything a visitor or a crawler reads: body text, title, description, JSON-LD. */
  said: string
  description: string
  indexed: boolean
}

const SKIPPED = new Set(["script", "style", "template"])
const visibleText = (node: TreeNode): string =>
  node.tagName && SKIPPED.has(node.tagName)
    ? ""
    : node.nodeName === "#text"
      ? (node.value ?? "")
      : (node.childNodes ?? []).map(visibleText).join(" ")

/** JSON-LD keys whose values are addresses or codes, never prose. */
const NOT_PROSE = new Set([
  "@id",
  "@context",
  "@type",
  "url",
  "sameAs",
  "image",
  "logo",
  "item",
  "telephone",
  "email",
])

/** The prose strings of a JSON-LD block (names, descriptions, answers), not its addresses. Unparsable text is the structured data gate's to fail. */
function proseOf(json: string): string {
  const strings = (value: unknown, key = ""): string[] =>
    NOT_PROSE.has(key)
      ? []
      : typeof value === "string"
        ? [value]
        : Array.isArray(value)
          ? value.flatMap((v) => strings(v, key))
          : value && typeof value === "object"
            ? Object.entries(value).flatMap(([k, v]) => strings(v, k))
            : []
  try {
    return strings(JSON.parse(json)).join(" ")
  } catch {
    return ""
  }
}

/** URLs, emails and bare host names: addresses, spelled as they are, never words to check. */
const ADDRESSES =
  /(?:https?:\/\/|www\.)\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\b(?:\/\S*)?/gi

function read(html: string): Read {
  const out: Read = {
    title: "",
    headings: [],
    copy: [],
    marks: new Set(),
    towns: [],
    said: "",
    description: "",
    indexed: true,
  }
  const extra: string[] = []
  const walk = (node: TreeNode, path: string, inMain: boolean) => {
    const children = node.childNodes ?? node.content?.childNodes ?? []
    const counts = new Map<string, number>()
    for (const child of children) {
      if (!child.tagName) continue
      const seen = counts.get(child.tagName) ?? 0
      counts.set(child.tagName, seen + 1)
      const at = `${path ? `${path}>` : ""}${seen === 0 ? child.tagName : `${child.tagName}[${seen}]`}`
      const tag = child.tagName
      if (tag === "title") out.title = squash(textOf(child))
      if (tag === "meta" && attr(child, "name") === "description")
        out.description = (attr(child, "content") ?? "").trim()
      if (
        tag === "meta" &&
        ["description", "og:description", "og:title"].some(
          (name) =>
            attr(child, "name") === name || attr(child, "property") === name
        )
      )
        extra.push(attr(child, "content") ?? "")
      if (tag === "script" && attr(child, "type") === "application/ld+json")
        extra.push(proseOf(textOf(child)))
      if (
        tag === "meta" &&
        attr(child, "name") === "robots" &&
        /noindex/i.test(attr(child, "content") ?? "")
      )
        out.indexed = false
      const main = inMain || tag === "main"
      if (main && (tag === "h1" || tag === "h2")) {
        const text = squash(textOf(child))
        if (text) out.headings.push({ tag, text, node: at })
      }
      const kind = attr(child, "data-copy")
      if (kind) out.marks.add(kind)
      if (kind === "area_town")
        out.towns.push({ text: squash(textOf(child)), node: at })
      if (kind && Object.hasOwn(COPY_WORDS, kind)) {
        out.copy.push({
          kind: kind as CopyKind,
          text: squash(textOf(child)),
          node: at,
        })
      }
      walk(child, at, main)
    }
  }
  const tree = parse(html) as unknown as TreeNode
  walk(tree, "", false)
  out.said = [squash(visibleText(tree)), out.title, ...extra]
    .join(" ")
    .replace(ADDRESSES, " ")
  return out
}

/** The blocks a page fails without, by built file: the `data-copy` mark and its fields. */
const BLOCKS: [RegExp, [string, string][]][] = [
  [
    /^services\/[^/]+\/index\.html$/,
    [
      ["service_includes", "serviceNIncludes (what is included)"],
      ["service_for", "serviceNFor (who it suits)"],
    ],
  ],
  [
    /^about\/index\.html$/,
    [
      [
        "approach_body",
        "approach1Title to approach4Body (how the work is done)",
      ],
      [
        "step_body",
        "aboutStep1Title to aboutStep4Body (what to expect on a visit)",
      ],
    ],
  ],
  [
    /^contact\/index\.html$/,
    [["contact_body", "contactIncludeBody (what to put in a message)"]],
  ],
]

/** Edit distance one: a letter dropped, added or swapped for another. */
const oneOff = (a: string, b: string) => {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const rest = (x: string) => x.slice(i + 1)
  return rest(a) === rest(b) || rest(a) === b.slice(i) || a.slice(i) === rest(b)
}

const levenshtein = (a: string, b: string) => {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++)
      next.push(
        Math.min(
          (row[j] ?? 0) + 1,
          (next[j - 1] ?? 0) + 1,
          (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
        )
      )
    row = next
  }
  return row[b.length] ?? 0
}

const singular = (word: string) =>
  word
    .replace(/ies$/, "y")
    .replace(/([sx]|[cs]h)es$/, "$1")
    .replace(/s$/, "")

/**
 * A word that is a slip for one of the business's terms, not another form of
 * it: one letter off before the last two (a different ending is another word,
 * "cleaned" for "cleaner"), or a long word sharing all but its ending with one
 * and within three edits ("conservative" for "conservatory").
 */
const slipFor = (word: string, term: string) => {
  const a = singular(word)
  const b = singular(term)
  if (a === b || Math.min(a.length, b.length) < 6) return false
  let shared = 0
  while (a[shared] && a[shared] === b[shared]) shared++
  const shorter = Math.min(a.length, b.length)
  if (oneOff(a, b) && shared < shorter - 2) return true
  return shorter >= 10 && shared >= 8 && levenshtein(a, b) <= 3
}

/**
 * Everyday words that sit one slip from another trade's: a gutter clearer
 * writes "cleaning" and a cleaner "clearing", and neither is a typo.
 * shortcut: a short list, not a dictionary; grow it when a real word is flagged.
 */
const COMMON = new Set(
  "cleaning clearing cleaner clearer painting planting planning pointing printing plumbing heating healing sealing dealing fitting fixing mowing moving roofing".split(
    " "
  )
)

const stringsOf = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(stringsOf)
      : value && typeof value === "object"
        ? Object.values(value).flatMap(stringsOf)
        : []

/** The facts that describe the work: service names, the trade, how it runs, who for. */
const TERM_KEYS = new Set([
  "business.offerings",
  "business.industry",
  "business.tagline",
  "business.overview",
  "business.audience",
  "business.proof",
])

/** What the copy may say: every word in the facts, and those of them that name the work. */
export function factWords(facts: readonly FactRecord[]) {
  const known = new Set<string>()
  const terms = new Set<string>()
  for (const fact of facts)
    for (const word of stringsOf(fact.value).flatMap(wordsOf)) {
      known.add(word)
      if (TERM_KEYS.has(fact.key) && word.length >= 6) terms.add(word)
    }
  return { known, terms }
}

/**
 * Every copy finding on the built site, in page order. `areas` is the
 * service-area fact's text; `words` the facts' words, which hold the copy's
 * own terms to their spelling.
 */
export function copyFindings(
  pages: readonly { file: string; html: string }[],
  areas = "",
  words: ReturnType<typeof factWords> = { known: new Set(), terms: new Set() }
): CopyFinding[] {
  const found: CopyFinding[] = []
  const headings: { file: string; text: string; stems: Set<string> }[] = []
  const steps: { file: string; text: string; stems: Set<string> }[] = []
  const titles = new Map<string, string>()
  const named = new Set(wordsOf(areas))
  const places = plainText(areas)
  for (const { file, html } of pages) {
    const page = read(html)
    if (!page.indexed) continue
    const title = plainText(page.title)
    const other = title && titles.get(title)
    if (other)
      found.push({
        file,
        node: "title",
        problem: "duplicate",
        text: page.title,
        detail: `the page title is the same as ${other}'s; each page needs its own`,
      })
    else if (title) titles.set(title, file)

    const titleLength = page.title.length
    if (titleLength < TITLE_CHARS.min || titleLength > TITLE_CHARS.max)
      found.push({
        file,
        node: "title",
        problem: "short",
        text: page.title,
        detail: `the page title is ${titleLength} characters; write ${TITLE_CHARS.min} to ${TITLE_CHARS.max}`,
      })

    const length = page.description.length
    if (length < DESCRIPTION_CHARS.min || length > DESCRIPTION_CHARS.max)
      found.push({
        file,
        node: "meta[description]",
        problem: "short",
        text: page.description,
        detail: `the meta description is ${length} characters; write one sentence of ${DESCRIPTION_CHARS.min} to 160`,
      })

    const said = new Set<string>()
    for (const leak of LEAKS.flatMap((pattern) => [
      ...page.said.matchAll(pattern),
    ])) {
      // One finding per phrase: the FAQ answer and its JSON-LD say it twice.
      const phrase = leak[0].toLowerCase()
      if (said.has(phrase)) continue
      said.add(phrase)
      const end = leak.index + leak[0].length
      found.push({
        file,
        node: "text",
        problem: "leak",
        text: page.said.slice(Math.max(0, leak.index - 30), end + 40),
        detail: `the copy says "${leak[0]}", which talks about what the writer was told; a visitor must never read it. Leave the question or sentence out, or answer only what is true of the trade in general`,
      })
    }

    for (const [mark, field] of BLOCKS.find(([pattern]) =>
      pattern.test(file)
    )?.[1] ?? [])
      if (!page.marks.has(mark))
        found.push({
          file,
          node: "main",
          problem: "missing",
          text: "",
          detail: `the page has no ${field} block; fill it for this page`,
        })
    // With two services or more, the services page helps a visitor choose.
    if (
      file === "services/index.html" &&
      page.copy.filter((c) => c.kind === "service_body").length > 1 &&
      !page.marks.has("services_help")
    )
      found.push({
        file,
        node: "main",
        problem: "missing",
        text: "",
        detail:
          "the page has no servicesHelpBody block (which service suits whom); fill it for this page",
      })

    if (places) {
      for (const town of page.towns)
        if (!places.includes(plainText(town.text)))
          found.push({
            file,
            node: town.node,
            problem: "town",
            text: town.text,
            detail: `the town is not one service_area.text names; areaTowns lists only those places, spelled as given`,
          })
      // A place name one letter off a named one is a misspelling of it.
      for (const word of page.said.match(/\b[A-Z][a-z]{4,}\b/g) ?? []) {
        const lower = word.toLowerCase()
        const real = [...named].find((n) => oneOff(lower, n))
        if (real && !named.has(lower))
          found.push({
            file,
            node: "text",
            problem: "town",
            text: word,
            detail: `"${word}" looks like a misspelling of "${real}", which service_area.text names; spell places as given`,
          })
      }
    }

    // A word one slip away from a service name or the trade is a misspelling.
    const slips = new Set<string>()
    for (const word of wordsOf(page.said)) {
      if (
        word.length < 6 ||
        words.known.has(word) ||
        COMMON.has(word) ||
        slips.has(word)
      )
        continue
      const real = [...words.terms].find((term) => slipFor(word, term))
      if (!real) continue
      slips.add(word)
      found.push({
        file,
        node: "text",
        problem: "term",
        text: word,
        detail: `"${word}" looks like a misspelling of "${real}", a word in the business's own facts; spell service names and the trade exactly as given, or reword if "${word}" is meant`,
      })
    }

    for (const h of page.headings) {
      if (STOCK_HEADINGS.includes(plainText(h.text))) {
        found.push({
          file,
          node: h.node,
          problem: "stock",
          text: h.text,
          detail: `the ${h.tag} is a stock label; keep it as the eyebrow and write a heading that names this business's service or place`,
        })
        continue
      }
      const stems = stemsOf(h.text)
      const first = headings.find((each) => alike(each.stems, stems))
      if (first) {
        found.push({
          file,
          node: h.node,
          problem: "duplicate",
          text: h.text,
          detail:
            first.file === file
              ? `the ${h.tag} repeats "${first.text}" on the same page`
              : `the ${h.tag} repeats "${first.text}" from ${first.file}; write this page's own (each page has its own closing band, aboutCtaHeading and the rest, and each service page its own fields), or when one shared section sits on both pages, drop it from one page's layout entry`,
        })
      } else headings.push({ file, text: h.text, stems })
    }

    const about = page.copy.filter((c) => c.kind === "about_body")
    const aboutWords = about.reduce((n, c) => n + wordsOf(c.text).length, 0)
    if (about[0] && aboutWords < COPY_WORDS.about_body.min)
      found.push({
        file,
        node: about[0].node,
        problem: "short",
        text: about.map((c) => c.text).join(" "),
        detail: `${LABEL.about_body} has ${aboutWords} words; write ${COPY_WORDS.about_body.aim[0]} to ${COPY_WORDS.about_body.aim[1]}, rephrasing every part of business.overview and business.audience`,
      })

    for (const c of page.copy) {
      if (c.kind === "about_body") continue
      const count = wordsOf(c.text).length
      const { aim, min } = COPY_WORDS[c.kind]
      if (count < min)
        found.push({
          file,
          node: c.node,
          problem: "short",
          text: c.text,
          detail: `${LABEL[c.kind]} has ${count} words; write ${aim[0]} to ${aim[1]}`,
        })
      if (c.kind !== "step_body") continue
      // No two pages share a step: each service page has its own.
      const stems = stemsOf(c.text)
      const first = steps.find((each) => alike(each.stems, stems))
      if (first)
        found.push({
          file,
          node: c.node,
          problem: "duplicate",
          text: c.text,
          detail: `the step repeats "${first.text}" from ${first.file}; write this page's own steps (serviceNStep1Title to serviceNStep4Body on a service page)`,
        })
      else steps.push({ file, text: c.text, stems })
    }
  }
  return found
}

/** A site field's gated section, by its name in src/site-config.ts. */
const FIELD_KINDS: [RegExp, CopyKind][] = [
  [/^homeIntro$/, "hero_lede"],
  [/^service\dBody$/, "service_body"],
  [/^service\dDetail$/, "service_detail"],
  [/^(?:step|service\dStep|aboutStep)\dBody$/, "step_body"],
  [/^(?:faq|service\dFaq|servicesFaq)\dAnswer$/, "faq_answer"],
  [/^approach\dBody$/, "approach_body"],
  [/^proofBody$/, "proof_body"],
  [/^servicesHelpBody$/, "services_help"],
  [/^contactIncludeBody$/, "contact_body"],
]

/**
 * The blocks a page's writer must fill, by page: the field pattern, how many
 * entries at least, and what to write. Only checked when the writer owns the
 * first field, so a page whose recipe does not hold the block is never held to it.
 */
const PAGE_BLOCKS: Record<
  string,
  { first: string; fields: RegExp; least: number; ask: string }[]
> = {
  about: [
    {
      first: "approach1Title",
      fields: /^approach\dBody$/,
      least: 3,
      ask: `three or four principles of how the work is done (approach1Title to approach4Body, each body ${COPY_WORDS.approach_body.aim[0]} to ${COPY_WORDS.approach_body.aim[1]} words) under approachHeading`,
    },
    {
      first: "aboutStep1Title",
      fields: /^aboutStep\dBody$/,
      least: 3,
      ask: `three or four steps of what happens on a visit (aboutStep1Title to aboutStep4Body, each body ${COPY_WORDS.step_body.aim[0]} to ${COPY_WORDS.step_body.aim[1]} words) under aboutStepsHeading`,
    },
  ],
  services: [
    {
      first: "servicesHelpBody",
      fields: /^servicesHelpBody$/,
      least: 1,
      ask: `servicesHelpBody, ${COPY_WORDS.services_help.aim[0]} to ${COPY_WORDS.services_help.aim[1]} words on which service suits whom, under servicesHelpHeading`,
    },
  ],
  contact: [
    {
      first: "contactIncludeBody",
      fields: /^contactIncludeBody$/,
      least: 1,
      ask: `contactIncludeBody, ${COPY_WORDS.contact_body.aim[0]} to ${COPY_WORDS.contact_body.aim[1]} words on what to put in a message, under contactIncludeHeading`,
    },
  ],
}
/** A page's SEO title or description field: homeTitle, service2Description and the rest. */
const PAGE_META =
  /^(?:home|about|services|serviceArea|contact|quote|service\d)(Title|Description)$/
/**
 * A page's <title> as the starter's Seo component writes it from the title
 * field: the business name goes after a title that does not contain it
 * exactly. Perf run 2's writers wrote 55 characters with "Brightside Care"
 * and the page showed 91, which the lead then spent four turns on.
 */
export const titleOf = (title: string, business: string) =>
  business && !title.includes(business)
    ? [title, business].filter(Boolean).join(" | ")
    : title

/** Fields that render an h1 or h2 inside <main>: every heading but the h3 and the chrome's. */
const headingField = (name: string) =>
  /(?:Heading|^service\dName)$/.test(name) &&
  !/^(?:audience|footer\w+|notFound)Heading$/.test(name)

/**
 * The copy gate's field rules for one writer's own fields, read from
 * src/site-config.ts before anything is built, so a page builder fixes its
 * page in its own session instead of the lead in a repair round. `values` is
 * every field on the site, siblings' included, so a heading is held against
 * every other heading already written. Only filled fields are checked, except
 * a closing band whose body is written and heading is not, which would show
 * the home page's. `page` is the writer's page: the about body is counted
 * only on the about page, where the gate counts it.
 */
export function fieldFindings(
  values: Readonly<Record<string, string>>,
  owned: readonly string[],
  page?: string
): string[] {
  const found: string[] = []
  let repeats = false
  const filled = (name: string) => (values[name] ?? "").trim()
  const business = filled("businessName")
  const headings = Object.keys(values).filter(
    (name) => headingField(name) && filled(name)
  )
  for (const name of owned) {
    const text = filled(name)
    if (!text) {
      const body = name.replace(/Heading$/, "Body")
      if (/.CtaHeading$/.test(name) && owned.includes(body) && filled(body))
        found.push(
          `${name} is empty, so this page's closing band shows the home page's ctaHeading, a repeat; write this page's own`
        )
      continue
    }
    const kind = FIELD_KINDS.find(([pattern]) => pattern.test(name))?.[1]
    const count = wordsOf(text).length
    if (kind && count < COPY_WORDS[kind].min)
      found.push(
        `${name} has ${count} words; write ${COPY_WORDS[kind].aim[0]} to ${COPY_WORDS[kind].aim[1]}`
      )
    const meta = PAGE_META.exec(name)?.[1]
    const chars = meta === "Title" ? TITLE_CHARS : DESCRIPTION_CHARS
    const shown = meta === "Title" ? titleOf(text, business) : text
    if (meta && (shown.length < chars.min || shown.length > chars.max))
      found.push(
        shown === text
          ? `${name} is ${text.length} characters; write ${chars.min} to ${meta === "Title" ? chars.max : 160}`
          : `${name} shows as "${shown}", ${shown.length} characters, because a title that does not contain businessName exactly gets " | ${business}" after it; write ${chars.min} to ${chars.max} in all, or name the business exactly within that`
      )
    const twin =
      meta &&
      Object.keys(values).find(
        (field) =>
          field !== name &&
          PAGE_META.exec(field)?.[1] === meta &&
          filled(field) &&
          (meta === "Title"
            ? titleOf(filled(field), business) === shown
            : filled(field) === text)
      )
    if (twin)
      found.push(
        `${name} is the same as ${twin}; each page needs its own ${meta === "Title" ? "title" : "description"}`
      )
    if (!headingField(name)) continue
    if (STOCK_HEADINGS.includes(plainText(text))) {
      found.push(
        `${name} "${text}" is a stock label; name this business's service, customer or place`
      )
      continue
    }
    const stems = stemsOf(text)
    const other = headings.find(
      (each) => each !== name && alike(stemsOf(filled(each)), stems)
    )
    if (other) {
      repeats = true
      found.push(
        `${name} "${text}" repeats ${other} "${filled(other)}"; give it its own words`
      )
    }
  }
  if (page === "about" && owned.includes("overviewBody")) {
    const body = `${filled("overviewBody") || filled("overview")} ${filled("audienceBody") || filled("audience")}`
    const count = wordsOf(body).length
    if (count > 0 && count < COPY_WORDS.about_body.min)
      found.push(
        `overviewBody and audienceBody have ${count} words together; write ${COPY_WORDS.about_body.aim[0]} to ${COPY_WORDS.about_body.aim[1]}, rephrasing every part of business.overview and business.audience`
      )
  }
  for (const block of PAGE_BLOCKS[page ?? ""] ?? []) {
    if (!owned.includes(block.first)) continue
    const written = owned.filter(
      (name) => block.fields.test(name) && filled(name)
    ).length
    if (written < block.least)
      found.push(
        `the ${page} page needs ${block.ask}; write it from the facts and this trade's usual practice`
      )
  }
  if (repeats)
    found.push(
      `Headings already on the site: ${headings.map((h) => `"${filled(h)}"`).join(", ")}.`
    )
  return found
}

/**
 * The gate's rules as the lines the writer's brief carries, built from the
 * constants above so a threshold changed here changes the brief with it.
 */
export function copyGateRules(): string[] {
  const words = (Object.keys(COPY_WORDS) as CopyKind[]).map((kind) => {
    const { aim, min } = COPY_WORDS[kind]
    return `${LABEL[kind]} ${aim[0]} to ${aim[1]} words, never under ${min}`
  })
  return [
    `- The copy gate runs after you, and each miss costs a repair round, so meet its numbers the first time. Every page title is ${TITLE_CHARS.min} to ${TITLE_CHARS.max} characters as the page shows it: a title that does not contain businessName exactly gets " | " and businessName after it, so either name the business exactly as businessName or leave room for it. Every meta description ${DESCRIPTION_CHARS.min} to ${DESCRIPTION_CHARS.max} characters; no two pages share either.`,
    `- Words per section: ${words.join("; ")}.`,
    `- Headings: no h1 or h2 on the site repeats another or is a stock label, and an h2 is never the same as or close to its own page's h1: ${Math.round(NEAR * 100)} percent of the significant words shared, in any order, counts as the same ("Deep cleaning in Bristol" under "Bristol deep cleaning"). Give every h2 its own words. Each process step's body is its own: no two steps on the site share their words.`,
  ]
}

/** The findings as one message the Developer can act on, every item named. */
export function copyMessage(findings: readonly CopyFinding[]): string {
  const cut = (text: string) =>
    text.length > 80 ? `${text.slice(0, 77)}...` : text
  return [
    `${findings.length} copy problem(s):`,
    ...findings.map((f) => `- ${f.file}: "${cut(f.text)}": ${f.detail}`),
  ].join("\n")
}

/** The gate's verdict. `planned` is false on a revise and the quick lane, which pass. */
export function checkCopy(
  pages: readonly { file: string; html: string }[],
  planned: boolean,
  facts: readonly FactRecord[] = []
): GateResult {
  const verdict = (passed: boolean, message: string, node: string | null) => ({
    gate: "copy" as const,
    passed,
    evidence_key: null,
    offending_node: node,
    message,
  })
  if (!planned)
    return verdict(
      true,
      "not a planned first build, so copy is not checked",
      null
    )
  const area = facts.find((f) => f.key === "service_area.text")?.value
  const findings = copyFindings(
    pages,
    typeof area === "string" ? area : "",
    factWords(facts)
  )
  const first = findings[0]
  if (!first)
    return verdict(
      true,
      "every heading and title is the site's only one, and every section has its words",
      null
    )
  return verdict(false, copyMessage(findings), `${first.file} ${first.node}`)
}
