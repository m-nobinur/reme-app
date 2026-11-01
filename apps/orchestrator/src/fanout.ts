import {
  type Blueprint,
  INDUSTRY_PACK,
  type PageDocument,
  type PageId,
} from "@workspace/contracts"
import {
  COPY_WORDS,
  DESCRIPTION_CHARS,
  documentFindings,
  factsToAsk,
  fieldFindings,
  TITLE_CHARS,
} from "@workspace/gates"
import { bannedIn } from "@workspace/starter-site/copy-check"
import { ICONS, iconPath } from "@workspace/starter-site/icons"
import { documentPath, type Page } from "@workspace/starter-site/page-seed"
import { blueprintLines } from "./blueprint.ts"
import type { Brief } from "./brief.ts"
import {
  DESIGN_RULES,
  industryOf,
  packVoice,
  stableRules,
} from "./developer-rules.ts"
import {
  BLOCK_SHAPES,
  DOCUMENTS_DIR,
  PAGE_FIELDS,
  skeletons,
} from "./documents.ts"
import { SEED_DIGEST, SEED_FIELDS, STARTER_FILES } from "./seed.ts"
import { fieldLines } from "./write-pages.ts"

/**
 * BA4, the parallel first build (ADR-038). The lead writes the shell, then
 * calls `write_pages`, which runs every page writer and the copy writer as
 * one model call each, several at once (write-pages.ts), then assembles and
 * builds once. Code decides who owns which site field and writes each value
 * into its own line, so no two writers ever touch the same line of
 * src/site-config.ts, and nothing about the fan-out is left to the lead.
 */

/** A first build from a Blueprint fans out; a revise and the quick lane do not. */
export const fansOut = (
  brief: Brief
): brief is Brief & { blueprint: Blueprint } =>
  Boolean(brief.blueprint) && brief.restore_key === null && !brief.role

/** How many writers run at once: the five main pages and the copy writer in the first wave. */
export const FAN_OUT = 6

type Recipes = {
  pages: Partial<Record<PageId, { page: string; fields: string[] }>>
  packs: Record<
    string,
    { cta?: string; headings?: Record<string, string> } | undefined
  >
}
const RECIPES = JSON.parse(
  STARTER_FILES["src/recipes.json"] as string
) as Recipes

/** The most services a site shows, so the most service pages. */
const SERVICES_MAX = 6

/** How many service pages a build writes: one per offering, six at most. */
export const serviceCount = (brief: Brief) =>
  Math.min(
    SERVICES_MAX,
    (
      brief.snapshot.facts.find((f) => f.key === "business.offerings")?.value as
        | { items?: unknown[] }
        | undefined
    )?.items?.length ?? SERVICES_MAX
  )

/** Each service's name field, spelt as business.offerings gives it. */
export const offeredNames = (brief: Brief): Record<string, string> =>
  Object.fromEntries(
    (
      (
        brief.snapshot.facts.find((f) => f.key === "business.offerings")
          ?.value as { items?: unknown[] } | undefined
      )?.items ?? []
    )
      .slice(0, SERVICES_MAX)
      .flatMap((name, i) =>
        typeof name === "string" ? [[`service${i + 1}Name`, name]] : []
      )
  )

/** The facts the about page's writer owns when there is one, rather than the home page's. */
const ABOUT_FACTS = ["overview", "audience"]

/** One writer's task: its agent, what it writes, and the task it waits for. */
export type WriterTask = {
  agent: "page" | "copy"
  /** The page it writes, for the progress count; the FAQ writer's is the page that holds the FAQ. */
  page: PageId
  /** A service page's offering, its place (1 to 6) in business.offerings. */
  offering?: number
  /** The skeleton it fills (documents.ts `skeletons`), as "home.json" or "services/2.json". */
  file: string
  /** The ids of the skeleton's sections whose words it writes. */
  sections: string[]
  /** Whether it writes its page's title and description. */
  meta: boolean
  /** The src/site-config.ts fields it owns: the settings and the service catalogue its page shows. */
  fields: string[]
  prompt: string
  /** The index of the task that must finish first. */
  after?: number
}

/**
 * Every writer's task, which `write_pages` runs: one per planned page, one
 * per offering's page, and the FAQ writer for the site's one FAQ. Each owns
 * its sections and site fields, disjoint by construction: a field goes to
 * the first page in the plan whose recipe reads it, and the about page's
 * writer owns the business's own story when there is one. Each service page
 * waits for the home page, whose writer names the service and writes its
 * card. A task with nothing to write is left out.
 */
export function writerTasks(
  plan: Blueprint,
  services = SERVICES_MAX
): WriterTask[] {
  const docs = skeletons(plan)
  const faq = Object.entries(docs).flatMap(([file, doc]) =>
    doc.sections
      .filter((s) => s.kind === "faq")
      .map((s) => ({ file, page: doc.page as PageId, id: s.id }))
  )
  const faqIds = new Set(faq.map((f) => `${f.file}#${f.id}`))
  const taken = new Set<string>()
  const about = plan.pages.some((p) => p.page === "about") ? ABOUT_FACTS : []
  const fieldsOf = (page: PageId, own: (field: string) => boolean) => {
    const fields = (RECIPES.pages[page]?.fields ?? []).filter(
      (f) =>
        !PAGE_FIELDS.has(f) &&
        !taken.has(f) &&
        own(f) &&
        (page === "about" || !about.includes(f))
    )
    for (const f of fields) taken.add(f)
    return fields
  }
  const sectionsOf = (file: string) =>
    (docs[file]?.sections ?? [])
      .map((s) => s.id)
      .filter((id) => !faqIds.has(`${file}#${id}`))
  const pages: WriterTask[] = plan.pages
    .filter((p) => p.page !== "service")
    .map(({ page }) => {
      const file = documentPath(page as Page)
      const sections = sectionsOf(file)
      const fields = fieldsOf(page, () => true)
      return {
        agent: "page" as const,
        page,
        file,
        sections,
        meta: true,
        fields,
        prompt: `Page ${page}. Write its document, ${DOCUMENTS_DIR}/${file}: its title, its description and the words of its sections ${sections.join(", ")}.${fields.length > 0 ? ` Your fields in src/site-config.ts: ${fields.join(", ")}.` : ""}`,
      }
    })
  const writers: WriterTask[] = [
    ...pages,
    ...faq.slice(0, 1).map((f) => ({
      agent: "copy" as const,
      page: f.page,
      file: f.file,
      sections: [f.id],
      meta: false,
      fields: [],
      prompt: `The FAQ, the site's only one: the words of section ${f.id} of ${DOCUMENTS_DIR}/${f.file}.`,
    })),
  ]
  const home = writers.findIndex((t) => t.page === "home" && t.agent === "page")
  const servicePages: WriterTask[] = plan.pages.some(
    (p) => p.page === "service"
  )
    ? Array.from({ length: services }, (_, i) => {
        const n = i + 1
        const file = `services/${n}.json`
        const sections = sectionsOf(file)
        const fields = fieldsOf("service", (f) =>
          new RegExp(`^service${n}[A-Z]`).test(f)
        )
        return {
          agent: "page" as const,
          page: "service" as const,
          offering: n,
          file,
          sections,
          meta: true,
          fields,
          prompt: `Page service. Service ${n}'s own page, /services/<slug of service${n}Name>/, offering ${n} of the content plan: its title, its description and the words of its sections ${sections.join(", ")}. If service${n}Name is empty, write nothing.${fields.length > 0 ? ` Your fields in src/site-config.ts: ${fields.join(", ")}.` : ""}`,
          ...(home >= 0 ? { after: home } : {}),
        }
      })
    : []
  return [...writers, ...servicePages].filter(
    (t) => t.sections.length > 0 || t.fields.length > 0
  )
}

/** A writer's name in the lead's lines: the page, the service's number, or the FAQ. */
export const writerLabel = (task: WriterTask) =>
  task.agent === "copy" ? "faq" : `${task.page}${task.offering ?? ""}`

/** The plan's content entry for a task's page, if the plan has one. */
const contentOf = (plan: Blueprint, task: WriterTask) =>
  plan.content?.find(
    (c) => c.page === task.page && c.offering === (task.offering ?? 0)
  )

/**
 * Each skeleton section's line in the Blueprint, matched by kind and place
 * among its kind, for its purpose: the seed adds a service page's service
 * cards when the plan has none, so the two lists need not line up.
 */
function purposes(plan: Blueprint, task: WriterTask, doc: PageDocument) {
  const planned = plan.pages.find((p) => p.page === task.page)?.sections ?? []
  const seen = new Map<string, number>()
  return doc.sections.map((s) => {
    const nth = seen.get(s.kind) ?? 0
    seen.set(s.kind, nth + 1)
    return planned.filter((p) => p.kind === s.kind)[nth]?.purpose ?? ""
  })
}

/**
 * What a writer reads after its instructions: its task, its page's content
 * plan, the skeleton of what it writes (its sections, each with its
 * purpose, and the title and description when they are its own), then its
 * fields' lines in the site config as they are.
 */
export function writerUser(
  task: WriterTask,
  plan: Blueprint,
  source: string
): string {
  const doc = skeletons(plan)[task.file]
  const why = doc ? purposes(plan, task, doc) : []
  const skeleton = doc && {
    ...(task.meta ? { title: "", description: "" } : {}),
    sections: doc.sections.flatMap((s, i) =>
      task.sections.includes(s.id) ? [{ ...s, purpose: why[i] }] : []
    ),
  }
  const content = contentOf(plan, task)
  return [
    task.prompt,
    "",
    "<content_plan>",
    content
      ? JSON.stringify(content)
      : "None for this page: write from the Blueprint's purposes below.",
    "</content_plan>",
    ...(skeleton && task.sections.length > 0
      ? ["<skeleton>", JSON.stringify(skeleton), "</skeleton>"]
      : []),
    ...(task.fields.length > 0
      ? ["<fields>", fieldLines(source, task.fields), "</fields>"]
      : []),
  ].join("\n")
}

/**
 * Every string field of src/site-config.ts's values, as written: `name: "…"`
 * on its line or wrapped to the next. A value that is not one JSON string
 * literal (a template literal, a half-written edit) is left out.
 */
export function siteValues(source: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const [, name, literal] of source.matchAll(
    /^ {2}(\w+):\s*("(?:[^"\\\n]|\\.)*")/gm
  )) {
    try {
      values[name as string] = JSON.parse(literal as string) as string
    } catch {
      // Not JSON: the gate reads the built page later either way.
    }
  }
  return values
}

/** A document with only what one writer wrote: its sections, and its title and description when they are its own. */
export function writerView(doc: PageDocument, task: WriterTask): PageDocument {
  const { title, description, ...rest } = doc
  return {
    ...rest,
    ...(task.meta ? { title, description } : {}),
    sections: doc.sections.filter((s) => task.sections.includes(s.id)),
  }
}

/**
 * BA4's per-writer copy check: after a writer's reply is written, the copy
 * gate's rules over what it wrote, against every other page's document as
 * written so far, and the build's own copy check on its strings. Writers run
 * at once, so of two that collide the later one sees the earlier. Null when
 * nothing fails; the message otherwise, which goes to the writer's one
 * retry. In the confirming run of 2026-10-15 every one of the first gate's
 * nine misses was one of these, and the two repair rounds they cost took
 * 61 s and 18 s of the lead's turns after a gate run each.
 */
export function writerCheck(input: {
  task: WriterTask
  values: Readonly<Record<string, string>>
  /** The task's page as written, every writer's sections in it. */
  doc?: PageDocument
  /** Every other page as written. */
  others: readonly PageDocument[]
  services: number
}): string | null {
  const { task, values, doc } = input
  const view = doc && writerView(doc, task)
  const rest = doc
    ? [
        ...input.others,
        {
          ...doc,
          title: undefined,
          description: undefined,
          sections: doc.sections.filter((s) => !task.sections.includes(s.id)),
        },
      ]
    : input.others
  const found = [
    ...fieldFindings(values, task.fields),
    ...sandboxFindings(values, task.fields),
    ...(view
      ? [
          ...documentFindings(view, rest, {
            business: values.businessName,
            needsTable: task.page === "services" && input.services > 1,
          }),
          ...stringFindings(view),
        ]
      : []),
  ]
  if (found.length === 0) return null
  return [
    "The copy gate's check of what you wrote, before the build, found:",
    ...found.map((line) => `- ${line}`),
    "Fix exactly these in one more reply, then stop. This check runs once.",
  ].join("\n")
}

const EM_DASH = String.fromCharCode(0x2014)

/** One string's breaks of the build's own copy check: an em dash or a stock phrase. */
const lineFindings = (where: string, text: string) => [
  ...(text.includes(EM_DASH)
    ? [`${where} has an em dash; use a comma, a colon or two sentences`]
    : []),
  ...bannedIn(text).map(
    (phrase) => `${where} says "${phrase}"; say what the business does`
  ),
]

/**
 * The rules of the build's own copy check (packages/starter-site
 * copy-check.ts and its icon check) that one field can break: an em dash, a
 * stock phrase, an icon src/icons.ts does not hold. In perf run 2 the lead
 * fixed four guessed icons after its first build; a writer fixes its own.
 */
export function sandboxFindings(
  values: Readonly<Record<string, string>>,
  owned: readonly string[]
): string[] {
  return owned.flatMap((name) => {
    const text = (values[name] ?? "").trim()
    if (!text) return []
    if (/Icon$/.test(name))
      return iconPath(text)
        ? []
        : [
            `${name} "${text}" is not an icon; name one of: ${Object.keys(ICONS).join(", ")}`,
          ]
    return lineFindings(name, text)
  })
}

/** The same rules over a document's strings, a card's icon included, each named by its section. */
function stringFindings(doc: PageDocument): string[] {
  const strings = (value: unknown, key = ""): [string, string][] =>
    typeof value === "string"
      ? [[key, value]]
      : Array.isArray(value)
        ? value.flatMap((v) => strings(v, key))
        : value && typeof value === "object"
          ? Object.entries(value).flatMap(([k, v]) =>
              [
                "id",
                "type",
                "provenance",
                "kind",
                "variant",
                "src",
                "href",
              ].includes(k)
                ? []
                : strings(v, k)
            )
          : []
  return [
    ...lineFindings("the title", doc.title ?? ""),
    ...lineFindings("the description", doc.description ?? ""),
    ...doc.sections.flatMap((section) =>
      strings(section).flatMap(([key, text]) =>
        key === "icon"
          ? text && !iconPath(text)
            ? [
                `section ${section.id}'s icon "${text}" is not an icon; name one of: ${Object.keys(ICONS).join(", ")}`,
              ]
            : []
          : lineFindings(`section ${section.id}`, text)
      )
    ),
  ]
}

/** The pack's CTA and headings from src/recipes.json, as this build reads them. */
function packLines(brief: Brief): string[] {
  const id = (INDUSTRY_PACK as Record<string, string>)[
    industryOf(brief.snapshot.facts) ?? ""
  ]
  const pack = id ? RECIPES.packs[id] : undefined
  if (!pack) return []
  return [
    `- The pack's call-to-action label is "${pack.cta ?? "Request a quote"}": ctaLabel, navQuote and every button that asks for a quote use it.`,
    ...(pack.headings
      ? [
          `- The pack's headings, by site field. Reword each to name this business's own services or area, keeping its job: ${JSON.stringify(pack.headings)}`,
        ]
      : []),
  ]
}

/** The lead's build command: the check's last lines and only the build's errors and warnings. */
const BUILD_COMMAND =
  './node_modules/.bin/astro check 2>&1 | tail -n 15 && ./node_modules/.bin/astro build 2>&1 | grep -E "error|Error|WARN|copy-check" | head -n 40'

/** The lead's plan of work for a planned first build, after the Blueprint. */
export function leadLines(brief: Brief, plan: Blueprint): string[] {
  return [
    "How you build it, in three steps:",
    "1. The shell, yourself. In src/site-config.ts set direction, font and colour, then the fields every page shares: businessName, phone, email, logo, the nav labels and ctaLabel. Read what you need in one turn, write the shell in one edit call, then call checkpoint alone.",
    "2. The pages: call write_pages once, with no other tool call beside it. It writes every planned page's document from its content plan, the site fields and the one FAQ in parallel, each writer's work already through the copy gate's own check, places the photos as they are made, warms the image cache and commits. It returns one line per writer.",
    `3. Assembly, yourself. Integrate, do not re-review: the writers' pages and fields are done, so read only what a line says was left for you or failed, and fill its part where the line says: sections in that page's document, fields in src/site-config.ts. Then run \`${BUILD_COMMAND}\` once with bash, fix what it reports, and call report_complete.`,
    ...(plan.custom_sections?.length
      ? [
          `- After the pages, and only then, write the Blueprint's custom sections yourself under src/components/custom/, at most two: ${plan.custom_sections
            .slice(0, 2)
            .map((c) => c.name)
            .join(
              ", "
            )}, each placed with its words in its page's document as the custom section rules say.`,
        ]
      : []),
    '- After a run.interrupted message: read git log, and if there is no "pages" commit, call write_pages again; it replays the writers that already ran.',
    ...packLines(brief),
  ]
}

/** What every writer is told before its own part; one string for every page writer, so they share a cached prefix. */
function childPrefix(
  brief: Brief,
  role: string,
  /** The first rule: what follows the writer's task. */
  reading = "Your task follows, then your page's content plan, the skeleton of the document's sections you write, each with its purpose, and your fields' current lines in src/site-config.ts, each with its note."
): string[] {
  const { facts } = brief.snapshot
  const pack = packVoice(facts)
  const { hidden } = factsToAsk(SEED_FIELDS, facts)
  return [
    role,
    "",
    "Rules:",
    `- The lead has written the shell: direction, font and colour in src/site-config.ts, and each page's sections are the Blueprint's. ${reading}`,
    `- Each block is {id, type, provenance, eyebrow?, heading?} with its type's own keys and no others: ${BLOCK_SHAPES}.`,
    '- You have no tools. Reply with JSON only, shaped {"summary": string, "values": {"<field>": string}, "title": string, "description": string, "sections": {"<section id>": {"eyebrow": string, "heading": string, "intro": string, "blocks": [...]}}}. values has one entry for every field your task names and no other: the field\'s whole new text, or "" to leave it empty. sections has one entry for every section your task names and no other, and title and description come only when your task names them. Code writes each into its place while other writers fill the rest.',
    "- Write each section as its skeleton lays it out and as the starter reads it (src/page-document.ts; the document rules below say what each section shows). Keep every skeleton block's id and type and fill its words; leave out a block or an item you have nothing true for; add a block where your content plan needs one, with an id of its own. Never write kind, variant or purpose: those are the Blueprint's.",
    "- Follow your page's content plan: write the topics it owns under its outline's headings, in its order, for its target search, from its sources, and nothing another page owns. A block's provenance is facts when its words come from the facts, trade when they say what such work usually involves (the page labels it typical), and owner for a site.content piece placed word for word.",
    "- You cannot ask anyone anything. A field whose fact is missing stays empty; say so in your summary.",
    "- summary is one sentence of at most 40 words: what you filled, what you left empty and why. Never restate the copy you wrote.",
    ...stableRules(),
    ...(hidden.length > 0
      ? [
          `- The owner has asked that these facts not appear on the site: ${hidden.join(", ")}. No field may render them.`,
        ]
      : []),
    "",
    "Design rules:",
    ...DESIGN_RULES,
    "",
    "Components (name, file, props, never):",
    SEED_DIGEST,
    "",
    ...(pack.length > 0
      ? [`Industry pack (${industryOf(facts)}):`, ...pack, ""]
      : []),
    `Canonical facts (snapshot ${brief.snapshot.snapshot_id}):`,
    facts
      .map((f) => `- ${f.key} (${f.fact_type}): ${JSON.stringify(f.value)}`)
      .join("\n") || "- (none)",
    "",
    ...(brief.blueprint
      ? [...blueprintLines(brief.blueprint, brief.photos), ""]
      : []),
    ...packLines(brief),
  ]
}

/** A page builder's instructions: the same for every page, which its task names. */
export const pageInstructions = (brief: Brief) =>
  childPrefix(
    brief,
    "You are a page writer at Reme. Your task names one page of this business's site, the sections of its document you write and the site fields you own; you write them from the page's content plan, the canonical facts and the Blueprint, and nothing else. Image fields take the paths the Blueprint's image slots give."
  )
    .concat(PAGE_WRITER_RULES)
    .join("\n")

/**
 * What a page writer is told beyond the shared rules about its title and
 * description. The measured copy child took 98.5 s over 12 turns, against 8
 * to 25 s for a page: it counted characters in bash to hit 50 to 60 and 140
 * to 155 exactly, redrafted and measured again. The build's copy check
 * (packages/starter-site/src/copy-check.ts) already passes 50 to 60 and 140
 * to 165, so each writer is told to write once, by feel, and stop.
 */
export const PAGE_WRITER_RULES = `- Never count characters, measure or script anything: aim for a title of about 55 characters naming the page and the business exactly as businessName (the page adds " | " and businessName after any title that does not contain it), and a description of one sentence of about 150; the copy gate accepts ${TITLE_CHARS.min} to ${TITLE_CHARS.max} and ${DESCRIPTION_CHARS.min} to ${DESCRIPTION_CHARS.max} and fails any line outside, so a title over ${TITLE_CHARS.max} or a description under ${DESCRIPTION_CHARS.min} is a repair round. No two pages share a title or a description.`

/** What the FAQ writer is told beyond the shared rules. */
export const COPY_WRITER_RULES = [
  `- The FAQ is the site's only one, and follows the copy brief: up to eight questions, each answer ${COPY_WORDS.faq_answer.aim[0]} to ${COPY_WORDS.faq_answer.aim[1]} words, as full as the brief asks. Ask only what you can answer in full from the facts or from how the trade usually works, promising nothing for this business that a fact does not. Leave a question out rather than answer that you do not know: never write "our facts don't say", "isn't set out", "not stated" or any note about what you were told. The copy gate fails it. The heading names this business's customers or service, never "Common questions" or "FAQ", which may be the eyebrow. Ask nothing another page's content plan owns in full (a service's own scope, the area town by town); answer the questions that cut across the site.`,
].join("\n")

/** The FAQ writer's instructions: the site's one FAQ, from the facts. */
export const copyInstructions = (brief: Brief) =>
  [
    ...childPrefix(
      brief,
      "You are the FAQ writer at Reme. Your task names the site's one FAQ section: you write its eyebrow, heading, intro and one faq block, from the canonical facts and the trade's usual practice.",
      "Your task follows, then the content plan of the page that holds the FAQ and the skeleton of its FAQ section."
    ),
    COPY_WRITER_RULES,
  ].join("\n")
