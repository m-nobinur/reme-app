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
 * - a service page without its "what is included" or "who it suits" block;
 * - a page description outside the writer's 140 to 165 characters.
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
}

/** A page's meta description, in characters: the brief's 140 to 160 with a few over. */
export const DESCRIPTION_CHARS = { min: 140, max: 165 }

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
  problem: "duplicate" | "stock" | "short" | "leak" | "town" | "missing"
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
const NEAR = 0.75
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
        extra.push(textOf(child))
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
  out.said = [squash(visibleText(tree)), out.title, ...extra].join(" ")
  return out
}

/** Edit distance one: a letter dropped, added or swapped for another. */
const oneOff = (a: string, b: string) => {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const rest = (x: string) => x.slice(i + 1)
  return rest(a) === rest(b) || rest(a) === b.slice(i) || a.slice(i) === rest(b)
}

/** Every copy finding on the built site, in page order. `areas` is the service-area fact's text. */
export function copyFindings(
  pages: readonly { file: string; html: string }[],
  areas = ""
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

    const length = page.description.length
    if (length < DESCRIPTION_CHARS.min || length > DESCRIPTION_CHARS.max)
      found.push({
        file,
        node: "meta[description]",
        problem: "short",
        text: page.description,
        detail: `the meta description is ${length} characters; write one sentence of 140 to 160`,
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

    if (/^services\/[^/]+\/index\.html$/.test(file))
      for (const [mark, field] of [
        ["service_includes", "serviceNIncludes (what is included)"],
        ["service_for", "serviceNFor (who it suits)"],
      ] as const)
        if (!page.marks.has(mark))
          found.push({
            file,
            node: "main",
            problem: "missing",
            text: "",
            detail: `the service page has no ${field} block; fill it for this service`,
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
  const findings = copyFindings(pages, typeof area === "string" ? area : "")
  const first = findings[0]
  if (!first)
    return verdict(
      true,
      "every heading and title is the site's only one, and every section has its words",
      null
    )
  return verdict(false, copyMessage(findings), `${first.file} ${first.node}`)
}
