import {
  type Blueprint,
  INDUSTRY_PACK,
  type PageId,
} from "@workspace/contracts"
import { factsToAsk } from "@workspace/gates"
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
  const faq = plan.pages.some((p) => p.sections.some((s) => s.kind === "faq"))
  return [
    ...plan.pages.flatMap(({ page }) => [
      `${camel(page)}Title`,
      `${camel(page)}Description`,
    ]),
    ...(faq
      ? Array.from({ length: 8 }, (_, i) => [
          `faq${i + 1}Question`,
          `faq${i + 1}Answer`,
        ]).flat()
      : []),
  ]
}

/**
 * Each planned page and the site fields its builder owns: the recipe's
 * fields for that page, less the copy writer's and less any an earlier page
 * in the plan already owns. Disjoint by construction.
 */
export function pageTasks(
  plan: Blueprint
): { page: PageId; fields: string[] }[] {
  const taken = new Set(copyFields(plan))
  return plan.pages.map(({ page }) => {
    const fields = (RECIPES.pages[page]?.fields ?? []).filter(
      (f) => !taken.has(f)
    )
    for (const f of fields) taken.add(f)
    return { page, fields }
  })
}

/** The page a page builder's prompt names, for the progress count. */
export const pageOfPrompt = (prompt: string | undefined) =>
  /^Page ([a-z_]+)\./.exec(prompt ?? "")?.[1] ?? null

/** The task prompts, in the groups the lead sends them: one turn per group. */
export function taskGroups(
  plan: Blueprint
): { agent: "page" | "copy"; prompt: string }[][] {
  const tasks = [
    ...pageTasks(plan).map(({ page, fields }) => ({
      agent: "page" as const,
      prompt: `Page ${page}. Your layout entry: layout.${page}. Your fields: ${fields.join(", ") || "none beyond the layout entry"}.`,
    })),
    {
      agent: "copy" as const,
      prompt: `SEO and FAQ copy. Your fields: ${copyFields(plan).join(", ")}.`,
    },
  ]
  const groups: (typeof tasks)[] = []
  for (let i = 0; i < tasks.length; i += FAN_OUT) {
    groups.push(tasks.slice(i, i + FAN_OUT))
  }
  return groups
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
  const groups = taskGroups(plan)
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
function childPrefix(brief: Brief, role: string): string[] {
  const { facts } = brief.snapshot
  const pack = packVoice(facts)
  const { hidden } = factsToAsk(SEED_FIELDS, facts)
  return [
    role,
    "",
    "Rules:",
    "- The lead has written the shell: direction, font, colour and the `layout` export in src/site-config.ts. Read src/site-config.ts and the components your fields feed before you write.",
    "- Edit only the site fields your task names, and your page's layout entry when it names one, in src/site-config.ts, with one edit call whose edits are each anchored on the field's own line. Never touch another field, another page's entry or any other file: other subagents are editing the same file now.",
    "- Never run astro check or astro build; the lead builds once, after you.",
    "- You cannot ask anyone anything. A field whose fact is missing stays empty; say so in your summary.",
    "- End with one short paragraph: what you filled, what you left empty and why. Never paste file contents.",
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

/** The copy writer's instructions: SEO titles and descriptions and the FAQ, from the facts. */
export const copyInstructions = (brief: Brief) =>
  [
    ...childPrefix(
      brief,
      "You are the copy writer at Reme. Your task names the site fields you own: each page's SEO title and description, and the FAQ entries."
    ),
    "- A title is under 60 characters and names the business and the page; a description is one sentence under 155 characters. FAQ answers say only what a fact says; a question no fact answers is left out, its fields empty.",
  ].join("\n")

/** The catalog lines the lead sees for each subagent. */
export const PAGE_AGENT =
  "Fills one page of the site: its layout entry and the site fields the prompt names, from the facts and the Blueprint. Replies with a one-paragraph summary."
export const COPY_AGENT =
  "Writes each page's SEO title and description and the FAQ entries, in the fields the prompt names. Replies with a one-paragraph summary."
