import type { GateResult } from "@workspace/contracts"
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
 * - a section's copy under its minimum word count.
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
  faq_answer: { aim: [40, 90], min: 24 },
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
}

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
  problem: "duplicate" | "stock" | "short"
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
  indexed: boolean
}

function read(html: string): Read {
  const out: Read = { title: "", headings: [], copy: [], indexed: true }
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
  walk(parse(html) as unknown as TreeNode, "", false)
  return out
}

/** Every copy finding on the built site, in page order. */
export function copyFindings(
  pages: readonly { file: string; html: string }[]
): CopyFinding[] {
  const found: CopyFinding[] = []
  const headings: { file: string; text: string; stems: Set<string> }[] = []
  const steps: { file: string; text: string; stems: Set<string> }[] = []
  const titles = new Map<string, string>()
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

    for (const c of page.copy) {
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
  planned: boolean
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
  const findings = copyFindings(pages)
  const first = findings[0]
  if (!first)
    return verdict(
      true,
      "every heading and title is the site's only one, and every section has its words",
      null
    )
  return verdict(false, copyMessage(findings), `${first.file} ${first.node}`)
}
