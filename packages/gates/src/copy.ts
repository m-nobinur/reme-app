import {
  type FactRecord,
  FactValue,
  type GateResult,
  type PageDocument,
} from "@workspace/contracts"
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
 *   which may only be an eyebrow, and any h1, h2 or eyebrow that asks why to
 *   choose, trust or hire someone ("Why clients choose Acme");
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
 * - a sentence of six words or more that another page also says, contact
 *   details aside: each thing is said once, on the page that owns it;
 * - a service page without its "what is included" or "who it suits" block,
 *   a services page listing two services or more without the table that
 *   compares them, or a contact page without its note on what to send;
 * - a page title outside the writer's 50 to 60 characters, or a description
 *   outside its 140 to 165.
 *
 * The starter marks what is checked with `data-copy="<kind>"` on the
 * elements whose words are counted. Every h1 and h2 inside <main> is
 * compared, each page's closing band included; headings outside it (the
 * footer's) are site chrome and are not read, and neither are the starter's
 * own words that every service shows (SHARED).
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
  hero_lede: "the home hero's subhead (homeIntro; home.json's hero intro)",
  service_body: "a service card (serviceNBody)",
  service_detail: "a service page's intro (serviceNDetail)",
  step_body: "a process step (stepNBody; a steps block in the page's document)",
  faq_answer:
    "an FAQ answer (faqNAnswer, or serviceNFaqMAnswer on a service page; an faq block in the page's document)",
  about_body:
    "the about page's body (overviewBody and audienceBody together; about.json's about intro and its -audience block)",
  approach_body:
    "an about page principle (approachNBody; about.json's value_props cards)",
  proof_body: "the about page's record (proofBody; about.json's -record block)",
  services_help:
    "the services page's helper (servicesHelpBody; services.json's service_cards prose block)",
  contact_body:
    "the contact page's note on what to send (contactIncludeBody; contact.json's contact prose block)",
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

/** "Why choose us" in any form: why clients choose, trust, hire or book a business. */
const WHY_CHOOSE =
  /^why (?:\w+ ){0,2}(?:choose|pick|trust|hire|book|ride with|stay with)\b|^why us$/

const isStock = (text: string) =>
  STOCK_HEADINGS.includes(plainText(text)) || WHY_CHOOSE.test(plainText(text))

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
    | "headline"
    | "missing"
    | "repeat"
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
  eyebrows: { text: string; node: string }[]
  copy: { kind: CopyKind; text: string; node: string }[]
  /** Every `data-copy` value on the page, whether or not it has a word range. */
  marks: Set<string>
  /** The area chips' towns. */
  towns: { text: string; node: string }[]
  /** Everything a visitor or a crawler reads: body text, title, description, JSON-LD. */
  said: string
  description: string
  indexed: boolean
  /** Each leaf block of <main>, the service catalogue's shared lines aside. */
  lines: string[]
  table: boolean
}

const SKIPPED = new Set(["script", "style", "template"])

/** The elements whose words are one run of text, for splitting into sentences. */
const LEAF = new Set(
  "p li h1 h2 h3 h4 h5 h6 td th summary blockquote figcaption caption dd dt legend label".split(
    " "
  )
)
/** Marks of the starter's copy that several pages show: the services, their labels, the area and contact details. */
const SHARED = new Set([
  "area_facts",
  "contact_details",
  "service_body",
  "service_name",
  "service_label",
  "typical_note",
])
const hasLeaf = (node: TreeNode): boolean =>
  (node.childNodes ?? []).some(
    (c) => (c.tagName && LEAF.has(c.tagName)) || hasLeaf(c)
  )

/** How many words a sentence needs before two pages may not share it. */
export const REPEAT_WORDS = 6

/**
 * A text's sentences of `REPEAT_WORDS` words or more, as two pages compare
 * them: their words, lowercase. A sentence with a phone number, an email, a
 * web address or a time of day is contact detail, which every page may give.
 */
export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .filter(
      (s) =>
        !/\d[\d\s()+-]{6,}\d/.test(s) &&
        !/\d:\d\d/.test(s) &&
        !s.match(ADDRESSES)
    )
    .map(plainText)
    .filter((s) => s.split(" ").length >= REPEAT_WORDS)
}
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
    eyebrows: [],
    copy: [],
    marks: new Set(),
    towns: [],
    said: "",
    description: "",
    indexed: true,
    lines: [],
    table: false,
  }
  const extra: string[] = []
  const walk = (
    node: TreeNode,
    path: string,
    inMain: boolean,
    shared = false
  ) => {
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
      const kind = attr(child, "data-copy")
      if (main && (tag === "h1" || tag === "h2") && !SHARED.has(kind ?? "")) {
        const text = squash(textOf(child))
        if (text) out.headings.push({ tag, text, node: at })
      }
      if (main && attr(child, "class")?.split(" ").includes("eyebrow")) {
        const text = squash(textOf(child))
        if (text) out.eyebrows.push({ text, node: at })
      }
      if (kind) out.marks.add(kind)
      const own =
        shared ||
        SHARED.has(kind ?? "") ||
        attr(child, "aria-hidden") === "true"
      if (main && tag === "table") out.table = true
      // Headings are held to the heading rules, which catch a near repeat too.
      if (
        main &&
        !own &&
        LEAF.has(tag) &&
        !/^h\d$/.test(tag) &&
        !hasLeaf(child)
      ) {
        const line = squash(visibleText(child))
        if (line) out.lines.push(line)
      }
      if (kind === "area_town")
        out.towns.push({ text: squash(textOf(child)), node: at })
      if (kind && Object.hasOwn(COPY_WORDS, kind)) {
        out.copy.push({
          kind: kind as CopyKind,
          text: squash(textOf(child)),
          node: at,
        })
      }
      walk(child, at, main, own)
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
 * and within three edits ("conservative" for "conservatory"). A slip keeps
 * the first letter: a different one makes another word, "getting" beside the
 * facts' "letting".
 */
const slipFor = (word: string, term: string) => {
  const a = singular(word)
  const b = singular(term)
  if (a === b || Math.min(a.length, b.length) < 6) return false
  let shared = 0
  while (a[shared] && a[shared] === b[shared]) shared++
  const shorter = Math.min(a.length, b.length)
  if (oneOff(a, b) && shared > 0 && shared < shorter - 2) return true
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

/** The facts that name what the business does: the home headline has to. */
const WORK_KEYS = new Set(["business.offerings", "business.industry"])

/**
 * What the copy may say: every word in the facts, those of them that name the
 * work, the stems of the service and trade names, and the headings the owner
 * gave in their own words (a `site.content` title), which may be stock labels.
 */
export function factWords(facts: readonly FactRecord[]) {
  const known = new Set<string>()
  const terms = new Set<string>()
  const work = new Set<string>()
  const owned = new Set<string>()
  for (const fact of facts) {
    const content = FactValue.safeParse({ key: fact.key, value: fact.value })
    if (content.data?.key === "site.content")
      for (const { title } of content.data.value.items)
        owned.add(plainText(title))
    for (const word of stringsOf(fact.value).flatMap(wordsOf)) {
      known.add(word)
      if (TERM_KEYS.has(fact.key) && word.length >= 6) terms.add(word)
      if (WORK_KEYS.has(fact.key) && !FILLER.has(word) && word.length >= 4)
        work.add(word.slice(0, 5))
    }
  }
  return { known, terms, work, owned }
}

/**
 * Every copy finding on the built site, in page order. `areas` is the
 * service-area fact's text; `words` the facts' words, which hold the copy's
 * own terms to their spelling.
 */
export function copyFindings(
  pages: readonly { file: string; html: string }[],
  areas = "",
  words: ReturnType<typeof factWords> = {
    known: new Set(),
    terms: new Set(),
    work: new Set(),
    owned: new Set(),
  }
): CopyFinding[] {
  const found: CopyFinding[] = []
  const headings: { file: string; text: string; stems: Set<string> }[] = []
  const steps: { file: string; text: string; stems: Set<string> }[] = []
  const titles = new Map<string, string>()
  const repeats = repeatedSentences(pages)
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
    // With two services or more, the services page compares them, once.
    if (
      file === "services/index.html" &&
      page.copy.filter((c) => c.kind === "service_body").length > 1 &&
      !page.table
    )
      found.push({
        file,
        node: "main",
        problem: "missing",
        text: "",
        detail:
          "the page has no table comparing the services (the service, what it usually covers, who it suits); add it as a table block in a content section of services.json",
      })

    for (const { sentence, files } of repeats)
      if (files[0] !== file && files.includes(file))
        found.push({
          file,
          node: "text",
          problem: "repeat",
          text: sentence,
          detail: `the sentence "${sentence}" is on ${files[0]} too; say each thing once, on the page that owns the topic, and link there from this one`,
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

    for (const e of page.eyebrows)
      if (WHY_CHOOSE.test(plainText(e.text)))
        found.push({
          file,
          node: e.node,
          problem: "stock",
          text: e.text,
          detail: `the eyebrow is a stock label that fits any business; name this business's service, customer or place`,
        })

    for (const h of page.headings) {
      // "Leeds and around" is a place, not a headline: the h1 names the work.
      if (
        h.tag === "h1" &&
        file === "index.html" &&
        words.work.size > 0 &&
        ![...stemsOf(h.text)].some((stem) => words.work.has(stem))
      )
        found.push({
          file,
          node: h.node,
          problem: "headline",
          text: h.text,
          detail: `the home h1 names no service or outcome; write what the customer gets from this business's work (a service or the trade), with the place as the supporting detail`,
        })
      if (isStock(h.text) && !words.owned.has(plainText(h.text))) {
        found.push({
          file,
          node: h.node,
          problem: "stock",
          text: h.text,
          detail: `the ${h.tag} is a stock label; keep it as the eyebrow and write a heading that names this business's service or place`,
        })
        continue
      }
      if (places && plainText(h.text) === places) {
        found.push({
          file,
          node: h.node,
          problem: "repeat",
          text: h.text,
          detail: `the ${h.tag} is service_area.text word for word, which the service area page already shows as the area's own words; write a heading that names the place in new words`,
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

/**
 * Each sentence of `REPEAT_WORDS` words or more that two pages or more say,
 * with those pages in site order: what the gate fails, for the evals to count.
 * A page kept out of search is not read.
 */
export function repeatedSentences(
  pages: readonly { file: string; html: string }[]
): { sentence: string; files: string[] }[] {
  const seen = new Map<string, string[]>()
  for (const { file, html } of pages) {
    const page = read(html)
    if (!page.indexed) continue
    for (const sentence of new Set(page.lines.flatMap(sentencesOf)))
      seen.set(sentence, [...(seen.get(sentence) ?? []), file])
  }
  return [...seen]
    .filter(([, files]) => files.length > 1)
    .map(([sentence, files]) => ({ sentence, files }))
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
 * the home page's. A page's own words are its document's, which
 * `documentFindings` checks.
 */
export function fieldFindings(
  values: Readonly<Record<string, string>>,
  owned: readonly string[]
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
    if (isStock(text)) {
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
  if (repeats)
    found.push(
      `Headings already on the site: ${headings.map((h) => `"${filled(h)}"`).join(", ")}.`
    )
  return found
}

/** Keys of a block that hold an address or a code, never words a visitor reads. */
const NOT_WORDS = new Set(["id", "type", "provenance", "src", "href", "icon"])

/** A document's headings (each section's and each prose ## or ###) and its other lines, in page order. */
function documentText(doc: PageDocument) {
  const headings: string[] = []
  const eyebrows: string[] = []
  const lines: string[] = []
  const words = (value: unknown, key = ""): string[] =>
    NOT_WORDS.has(key)
      ? []
      : typeof value === "string"
        ? [value]
        : Array.isArray(value)
          ? value.flatMap((v) => words(v))
          : value && typeof value === "object"
            ? Object.entries(value).flatMap(([k, v]) => words(v, k))
            : []
  for (const section of doc.sections) {
    if (section.heading) headings.push(section.heading)
    if (section.eyebrow) eyebrows.push(section.eyebrow)
    for (const line of [section.eyebrow, section.intro])
      if (line) lines.push(line)
    for (const block of section.blocks ?? []) {
      if (block.type !== "prose") {
        lines.push(...words(block))
        continue
      }
      for (const line of block.markdown.split("\n")) {
        const heading = /^#{2,3}\s+(.+)$/.exec(line.trim())?.[1]
        if (heading) headings.push(heading)
        else if (line.trim())
          lines.push(line.replace(/^\s*(?:[-*]|\d+\.)\s+/, ""))
      }
    }
  }
  return { headings, eyebrows, lines }
}

/**
 * The copy gate's rules for one writer's page document, before anything is
 * built, against the documents its siblings have written so far: the title
 * and description, stock and repeated headings, words that talk about the
 * writer's inputs, a sentence another page already says, and the word
 * ranges of the FAQ answers, steps and the home hero's subhead. `needsTable`
 * is the services page of a site with two services or more, which compares
 * them in one table. One line per finding.
 */
export function documentFindings(
  doc: PageDocument,
  others: readonly PageDocument[],
  options: { business?: string; needsTable?: boolean }
): string[] {
  const found: string[] = []
  const business = options.business ?? ""
  const own = documentText(doc)
  const theirs = others.map(documentText)
  const meta = [
    ["title", doc.title, TITLE_CHARS],
    ["description", doc.description, DESCRIPTION_CHARS],
  ] as const
  // A writer that does not write the page's title and description is not held to them.
  for (const [name, text, chars] of meta) {
    if (text === undefined) continue
    const shown = name === "title" ? titleOf(text, business) : text
    if (shown.length < chars.min || shown.length > chars.max)
      found.push(
        shown === text
          ? `the ${name} is ${text.length} characters; write ${chars.min} to ${name === "title" ? chars.max : 160}`
          : `the title shows as "${shown}", ${shown.length} characters, because a title that does not contain the business name exactly gets " | ${business}" after it; write ${chars.min} to ${chars.max} in all, or name the business exactly within that`
      )
    if (text && others.some((o) => (o[name] ?? "") === text))
      found.push(`the ${name} is another page's; write this page's own`)
  }
  for (const section of doc.sections)
    if (
      section.kind === "about" &&
      !section.intro &&
      !(section.blocks ?? []).length
    )
      found.push(
        `the about section is empty; say each fact once, but write business.overview and business.audience here in the site's voice, ${COPY_WORDS.about_body.aim[0]} to ${COPY_WORDS.about_body.aim[1]} words`
      )
  for (const eyebrow of own.eyebrows)
    if (WHY_CHOOSE.test(plainText(eyebrow)))
      found.push(
        `the eyebrow "${eyebrow}" is a stock label that fits any business; name this business's service, customer or place`
      )
  const seen = theirs.flatMap((t) => t.headings)
  for (const heading of own.headings) {
    if (isStock(heading)) {
      found.push(
        `the heading "${heading}" is a stock label; keep it as the eyebrow and name this business's service, customer or place`
      )
      continue
    }
    const stems = stemsOf(heading)
    const twin = seen.find((other) => alike(stemsOf(other), stems))
    if (twin)
      found.push(
        `the heading "${heading}" repeats "${twin}"; give it its own words`
      )
    seen.push(heading)
  }
  const said = new Set(theirs.flatMap((t) => t.lines.flatMap(sentencesOf)))
  for (const line of own.lines) {
    for (const leak of LEAKS)
      for (const match of line.matchAll(leak))
        found.push(
          `"${line.slice(0, 80)}" says "${match[0]}", which talks about what you were told; leave it out, or say only what is true of the trade`
        )
    for (const sentence of sentencesOf(line))
      if (said.has(sentence))
        found.push(
          `"${sentence}" is on another page already; say each thing once, on the page that owns it`
        )
  }
  const short = (text: string, kind: CopyKind, what: string) => {
    const count = wordsOf(text).length
    if (text && count < COPY_WORDS[kind].min)
      found.push(
        `${what} "${text.slice(0, 60)}" has ${count} words; write ${COPY_WORDS[kind].aim[0]} to ${COPY_WORDS[kind].aim[1]}`
      )
  }
  for (const section of doc.sections) {
    if (doc.page === "home" && section.kind === "hero")
      short(section.intro ?? "", "hero_lede", "the hero's subhead")
    for (const block of section.blocks ?? []) {
      if (block.type === "faq")
        for (const item of block.items)
          short(item.answer, "faq_answer", "the answer")
      if (block.type === "steps")
        for (const item of block.items)
          short(item.body, "step_body", "the step")
    }
  }
  if (
    options.needsTable &&
    !doc.sections.some((s) => s.blocks?.some((b) => b.type === "table"))
  )
    found.push(
      "the services page needs one table block comparing the services (the service, what it usually covers, who it suits), in its content section"
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
    `- Headings: no h1 or h2 on the site repeats another or is a stock label, and an h2 is never the same as or close to its own page's h1: ${Math.round(NEAR * 100)} percent of the significant words shared, in any order, counts as the same ("Deep cleaning in Bristol" under "Bristol deep cleaning"). Give every h2 its own words. Each process step's body is its own: no two steps on the site share their words. The home h1 names a service or the trade from the facts, with the place as the supporting detail: "Leeds and around" fails.`,
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
