import {
  type Blueprint,
  INDUSTRY_PACK,
  type PageId,
} from "@workspace/contracts"
import {
  COPY_WORDS,
  DESCRIPTION_CHARS,
  factsToAsk,
  fieldFindings,
  TITLE_CHARS,
} from "@workspace/gates"
import { blueprintLines } from "./blueprint.ts"
import type { Brief } from "./brief.ts"
import {
  DESIGN_RULES,
  industryOf,
  packVoice,
  stableRules,
} from "./developer-rules.ts"
import { SEED_DIGEST, SEED_FIELDS, STARTER_FILES } from "./seed.ts"

/**
 * BA4, the parallel first build (ADR-038). The lead writes the shell, then
 * hands each page to a page builder and the SEO and FAQ copy to the copy
 * writer, at most four at once, then assembles and builds once. Code decides
 * who owns which site field, so no two children ever edit the same line of
 * src/site-config.ts, and writes the exact task prompts, so the lead copies
 * them instead of composing them.
 */

/** A first build from a Blueprint fans out; a revise and the quick lane do not. */
export const fansOut = (
  brief: Brief
): brief is Brief & { blueprint: Blueprint } =>
  Boolean(brief.blueprint) && brief.restore_key === null && !brief.role

/** How many subagents run at once. */
export const FAN_OUT = 4

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

/** `service_area` as the site field prefix `serviceArea`. */
const camel = (page: string) =>
  page.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

/** The copy writer's fields: each planned page's SEO title and description, and the FAQ entries. */
export function copyFields(plan: Blueprint): string[] {
  // Each service page's title, description and questions are its own task's.
  const pages = plan.pages.filter((p) => p.page !== "service")
  const faq = pages.some((p) => p.sections.some((s) => s.kind === "faq"))
  return [
    ...pages.flatMap(({ page }) => [
      `${camel(page)}Title`,
      `${camel(page)}Description`,
    ]),
    ...(faq ? ["faqEyebrow", "faqHeading"] : []),
    ...(faq
      ? Array.from({ length: 8 }, (_, i) => [
          `faq${i + 1}Question`,
          `faq${i + 1}Answer`,
        ]).flat()
      : []),
  ]
}

type PageTask = { page: PageId; fields: string[]; service?: number }

/** The most services a site shows, so the most service pages. */
export const SERVICES_MAX = 6

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

const ABOUT_BODY = ["overview", "overviewBody", "audience", "audienceBody"]

/**
 * Each planned page and the site fields its builder owns: the recipe's
 * fields for that page, less the copy writer's and less any an earlier page
 * in the plan already owns. Disjoint by construction. The `service` entry
 * plans every service's page at once and is one task per service, each
 * owning that service's fields (`service2Heading` and the rest).
 */
export function pageTasks(
  plan: Blueprint,
  services = SERVICES_MAX
): PageTask[] {
  const taken = new Set(copyFields(plan))
  // The about page's body is the one the copy gate counts (120 to 200 words),
  // so its builder writes it rather than the home page's, which wrote a teaser.
  const about = plan.pages.some((p) => p.page === "about") ? ABOUT_BODY : []
  return plan.pages.flatMap(({ page }): PageTask[] => {
    const fields = (RECIPES.pages[page]?.fields ?? []).filter(
      (f) => !taken.has(f) && (page === "about" || !about.includes(f))
    )
    for (const f of fields) taken.add(f)
    if (page !== "service") return [{ page, fields }]
    return Array.from({ length: services }, (_, i) => ({
      page,
      service: i + 1,
      fields: fields.filter((f) => new RegExp(`^service${i + 1}[A-Z]`).test(f)),
    }))
  })
}

/** The page a page builder's prompt names, for the progress count. */
export const pageOfPrompt = (prompt: string | undefined) =>
  /^Page ([a-z_]+)\./.exec(prompt ?? "")?.[1] ?? null

/** The site fields a task's prompt gives its writer, page builder or copy writer. */
export const fieldsOfPrompt = (prompt: string | undefined) =>
  /Your fields: ([\w, ]+)\.$/
    .exec(prompt ?? "")?.[1]
    ?.split(", ")
    .filter(Boolean) ?? []

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

/**
 * BA4's per-page copy check: after a writer's edit, the copy gate's field
 * rules over its own filled fields, against every heading on the site so
 * far. Siblings in one group write at once, so of two that collide the later
 * one sees the earlier. Null when nothing fails; the message otherwise, which
 * the writer acts on in the same session. The caller sends it once a task. In the confirming run of 2026-10-15 every one of the first
 * gate's nine misses was one of these, and the two repair rounds they cost
 * took 61 s and 18 s of the lead's turns after a gate run each.
 */
export function pageCheck(
  source: string,
  prompt: string | undefined
): string | null {
  const owned = fieldsOfPrompt(prompt)
  if (owned.length === 0) return null
  const found = fieldFindings(
    siteValues(source),
    owned,
    pageOfPrompt(prompt) ?? undefined
  )
  if (found.length === 0) return null
  return [
    "The copy gate's check of your fields, before the build, found:",
    ...found.map((line) => `- ${line}`),
    "Fix exactly these with one more edit call, then stop and write your summary. This check runs once.",
  ].join("\n")
}

/**
 * The task prompts, in the groups the lead sends them: one turn per group.
 * The service pages go last, in groups of their own, so each reads the
 * service's name and card that the home page's builder wrote.
 */
export function taskGroups(
  plan: Blueprint,
  services = SERVICES_MAX
): { agent: "page" | "copy"; prompt: string }[][] {
  const tasks = pageTasks(plan, services)
  const first = [
    ...tasks
      .filter((t) => t.service === undefined)
      .map(({ page, fields }) => ({
        agent: "page" as const,
        prompt: `Page ${page}. Your layout entry: layout.${page}. Your fields: ${fields.join(", ") || "none beyond the layout entry"}.`,
      })),
    {
      agent: "copy" as const,
      prompt: `SEO and FAQ copy. Your fields: ${copyFields(plan).join(", ")}.`,
    },
  ]
  const last = tasks
    .filter((t) => t.service !== undefined)
    .map(({ service, fields }) => ({
      agent: "page" as const,
      prompt: `Page service. Service ${service}'s own page, /services/<slug of service${service}Name>/, laid out by layout.service, which you leave as it is. If service${service}Name is empty, leave your fields empty and stop. Your fields: ${fields.join(", ")}.`,
    }))
  const chunk = <T>(list: T[]) =>
    Array.from({ length: Math.ceil(list.length / FAN_OUT) }, (_, i) =>
      list.slice(i * FAN_OUT, (i + 1) * FAN_OUT)
    )
  return [...chunk(first), ...chunk(last)]
}

/** The pack's CTA and headings from src/recipes.json, as this build reads them. */
export function packLines(brief: Brief): string[] {
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

/** Anthropic's parallel tool use guidance, worded for the fan-out. */
const PARALLEL =
  "<use_parallel_tool_calls>For maximum efficiency, whenever you perform multiple independent operations, invoke all relevant tools simultaneously rather than sequentially. A group of task calls below is independent: send the whole group in one message, with no other tool call beside it.</use_parallel_tool_calls>"

/** The lead's plan of work for a planned first build, after the Blueprint. */
export function leadLines(brief: Brief, plan: Blueprint): string[] {
  const groups = taskGroups(plan, serviceCount(brief))
  return [
    "How you build it, in three steps:",
    "1. The shell, yourself. In src/site-config.ts set direction, font and colour and write the `layout` export exactly as the Blueprint says, then the fields every page shares: businessName, phone, email, logo, the nav labels and ctaLabel. Call checkpoint.",
    `2. The pages, by subagent. Send these task calls, copying each agent and prompt exactly. Send group 1 in one message, and each later group once the one before it has returned.${groups.length > 1 ? "" : " There is one group."}`,
    ...groups.flatMap((group, i) => [
      `   Group ${i + 1}:`,
      ...group.map(
        (t) =>
          `   - task agent "${t.agent}", prompt ${JSON.stringify(t.prompt)}`
      ),
    ]),
    PARALLEL,
    "3. Assembly, yourself. Read each task's summary and git diff src/site-config.ts. A task that failed or was cancelled goes out once more, alone; one that fails again, you do yourself. Fill whatever the summaries say they left for you. Then call checkpoint, run astro check and astro build once, fix what they report, and call report_complete.",
    ...(plan.custom_sections?.length
      ? [
          `- After the pages, and only then, write the Blueprint's custom sections yourself under src/components/custom/, at most two: ${plan.custom_sections
            .slice(0, 2)
            .map((c) => c.name)
            .join(", ")}.`,
        ]
      : []),
    "- After a run.interrupted message: read git log and git diff, then send again only the tasks whose fields are still empty, in groups as above.",
    ...packLines(brief),
  ]
}

/** What every child is told before its own part; one string for every page builder, so they share a cached prefix. */
function childPrefix(
  brief: Brief,
  role: string,
  /** The first rule: a page builder reads the file first, the copy writer does not need to. */
  reading = "Read src/site-config.ts and the components your fields feed before you write."
): string[] {
  const { facts } = brief.snapshot
  const pack = packVoice(facts)
  const { hidden } = factsToAsk(SEED_FIELDS, facts)
  return [
    role,
    "",
    "Rules:",
    `- The lead has written the shell: direction, font, colour and the \`layout\` export in src/site-config.ts. ${reading}`,
    "- Edit only the site fields your task names, and your page's layout entry when it names one, in src/site-config.ts, with one edit call whose edits are each anchored on the field's own line. Never touch another field, another page's entry or any other file: other subagents are editing the same file now.",
    "- Never run astro check or astro build; the lead builds once, after you.",
    "- You cannot ask anyone anything. A field whose fact is missing stays empty; say so in your summary.",
    "- Write nothing between tool calls. End with one sentence of at most 40 words: what you filled, what you left empty and why. Never paste file contents or restate the copy you wrote.",
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
    "You are a page builder at Reme. Your task names one page of this business's site and the site fields you own on it; you write that page's copy from the canonical facts and the Blueprint, and nothing else. Image fields take the paths the Blueprint's image slots give."
  ).join("\n")

/**
 * What the copy writer is told beyond the shared rules. The measured copy child
 * took 98.5 s over 12 turns, against 8 to 25 s for a page: it drafted all 28
 * values in a script (no python3 in the sandbox), counted characters in bash to
 * hit 50 to 60 and 140 to 155 exactly, redrafted, edited, then measured and
 * edited again. It owns a fixed list of empty fields and the build's copy check
 * (packages/starter-site/src/copy-check.ts) already passes 50 to 60 and 140 to
 * 165, so it is told to write once, by feel, and stop.
 */
export const COPY_WRITER_RULES = [
  "- Write all your fields in one edit call as your first action, each edit anchored on the field's own empty line, for example `  homeTitle: \"\",`. Read a field's line only if an edit says it does not match. Use no other tool.",
  `- Never count characters, measure or script anything: aim for a title of about 55 characters naming the business and the page, and a description of one sentence of about 150; the copy gate accepts ${TITLE_CHARS.min} to ${TITLE_CHARS.max} and ${DESCRIPTION_CHARS.min} to ${DESCRIPTION_CHARS.max} and fails any line outside, so a title over ${TITLE_CHARS.max} or a description under ${DESCRIPTION_CHARS.min} is a repair round. No two pages share a title or a description.`,
  `- The FAQ follows the copy brief: up to eight questions, each answer ${COPY_WORDS.faq_answer.aim[0]} to ${COPY_WORDS.faq_answer.aim[1]} words, as full as the brief asks. Ask only what you can answer in full from the facts or from how the trade usually works, promising nothing for this business that a fact does not. Leave a question out rather than answer that you do not know: never write "our facts don't say", "isn't set out", "not stated" or any note about what you were told. The copy gate fails it. faqHeading names this business's customers or service, never "Common questions" or "FAQ", which may be faqEyebrow.`,
  "- When the edit succeeds, stop and write the summary. Do not read the file back or check your work.",
].join("\n")

/** The copy writer's instructions: SEO titles and descriptions and the FAQ, from the facts. */
export const copyInstructions = (brief: Brief) =>
  [
    ...childPrefix(
      brief,
      "You are the copy writer at Reme. Your task names the site fields you own: each page's SEO title and description, and the FAQ entries.",
      "Your fields are empty, one to a line, in src/site-config.ts, and everything you need is below."
    ),
    COPY_WRITER_RULES,
  ].join("\n")

/** The catalog lines the lead sees for each subagent. */
export const PAGE_AGENT =
  "Fills one page of the site: its layout entry and the site fields the prompt names, from the facts and the Blueprint. Replies with a one-sentence summary."
export const COPY_AGENT =
  "Writes each page's SEO title and description and the FAQ entries, in the fields the prompt names. Replies with a one-sentence summary."
