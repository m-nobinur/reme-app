import { readFileSync } from "node:fs"
import type { FactRecord } from "@workspace/contracts"
import { COPY_WORDS } from "@workspace/gates"
import DIRECTIONS from "@workspace/starter-site/directions.json"
import { describe, expect, it, vi } from "vitest"
import { blueprintLayout } from "../src/blueprint.ts"
import type { Brief } from "../src/brief.ts"
import {
  COPY_BRIEF,
  DESIGN_RULES,
  DIRECTION_LIBRARY,
  industryOf,
  packVoice,
} from "../src/developer-rules.ts"
import {
  COPY_WRITER_RULES,
  copyFields,
  copyInstructions,
  FAN_OUT,
  leadLines,
  pageInstructions,
  pageOfPrompt,
  pageTasks,
  taskGroups,
} from "../src/fanout.ts"
import {
  BUILD_MARK,
  instructions,
  sectionInstructions,
} from "../src/instructions.ts"
import { fallbackBlueprint } from "../src/planner.ts"

// The planner's brief.ts names the registry host from sandbox.ts, which loads the container SDK.
vi.mock("../src/sandbox.ts", () => ({
  NPM_REGISTRY_HOST: "registry.npmjs.org",
}))

const fact = (key: string, value: unknown): FactRecord => ({
  fact_id: "10000001-0000-4000-8000-000000000001",
  org_id: "10000001-0000-4000-8000-000000000000",
  key,
  fact_type: key.split(".")[0] as string,
  value,
  version: 1,
  provenance: {
    source: "owner_stated",
    confidence: 1,
    verified_by_staff_id: null,
    verified_at: null,
  },
  valid_from: "2026-10-14T12:00:00.000Z",
  valid_to: null,
  superseded_by_fact_id: null,
})

const brief = (facts: FactRecord[], restore: string | null = null): Brief =>
  ({
    snapshot: { snapshot_id: "snap-1", facts },
    goal: "Build the site",
    goal_tainted: false,
    acceptance_criteria: ["It builds"],
    restore_key: restore,
    map: "- src/site-config.ts",
  }) as unknown as Brief

const cleaning = fact("business.industry", {
  name: "Bright Clean",
  category: "cleaning",
})
const legal = fact("business.industry", {
  name: "Hale and Co",
  category: "legal",
})

describe("the twelve design rules", () => {
  it("are numbered one to twelve and reach the instructions", () => {
    expect(DESIGN_RULES).toHaveLength(12)
    DESIGN_RULES.forEach((rule, i) => {
      expect(rule.startsWith(`${i + 1}. `)).toBe(true)
    })
    const text = instructions(brief([cleaning]), 20)
    for (const rule of DESIGN_RULES) expect(text).toContain(rule)
  })
})

describe("the design directions", () => {
  it("reach the instructions, each with its variants and every palette's six roles", () => {
    const text = instructions(brief([cleaning]), 20)
    expect(text).toContain("Design directions:")
    for (const line of DIRECTION_LIBRARY) expect(text).toContain(line)
    for (const d of DIRECTIONS) {
      const line = DIRECTION_LIBRARY.find((each) =>
        each.startsWith(`- ${d.id} (`)
      )
      expect(line, d.id).toContain(`hero ${d.hero}, services ${d.services}`)
      for (const palette of d.palettes)
        expect(DIRECTION_LIBRARY.at(-1), palette).toMatch(
          new RegExp(
            `${palette} "paper:\\S+ ink:\\S+ primary:\\S+ tint:\\S+ accent:\\S+ line:\\S+"`
          )
        )
    }
  })
})

describe("the accessibility repair", () => {
  it("tells the lead to run the gate's own axe command and rerun it before it reports", () => {
    const text = instructions(brief([cleaning]), 20)
    expect(text).toContain("node /opt/astro/axe.mjs dist /tmp/axe.json")
    expect(text).toMatch(/validation\.failed message names the a11y gate/)
    expect(text).toMatch(/until it exits 0, and only then call report_complete/)
  })
})

describe("the instructions' cache order", () => {
  const at = (text: string, needle: string) => {
    const i = text.indexOf(needle)
    expect(i, needle).toBeGreaterThan(-1)
    return i
  }

  it("runs rules, design rules, components, then the build, its facts, the map and the goal", () => {
    const text = instructions(brief([cleaning]), 20)
    const order = [
      "Rules:",
      "The site never shows a price",
      "Design rules",
      "Design directions:",
      "Components (name, file, props, never):",
      BUILD_MARK,
      "This is a first build",
      "Canonical facts",
      "Site map",
      "Assignment goal",
      "Budget:",
    ].map((needle) => at(text, needle))
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it("puts a planned build's Blueprint after the facts, with its layout, and the directions before the mark", () => {
    const plan = fallbackBlueprint({ facts: [cleaning], recent: [] })
    const text = instructions({ ...brief([cleaning]), blueprint: plan }, 20)
    const order = [
      "Design directions:",
      BUILD_MARK,
      "Canonical facts",
      "Blueprint, the plan the owner approved",
      "Site map",
    ].map((needle) => at(text, needle))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(text).toContain(JSON.stringify(blueprintLayout(plan)))
    expect(text).toContain("Never delete a planned page, whatever the facts")
    expect(instructions(brief([cleaning]), 20)).not.toContain("Blueprint,")
  })

  it("shares one prefix across businesses in one industry and between a build and a revise", () => {
    const prefix = (text: string) => text.slice(0, text.indexOf(BUILD_MARK))
    const first = instructions(brief([cleaning]), 20)
    // The pack voice ends the stable segment, so the shared prefix is per industry.
    const other = instructions(
      brief(
        [cleaning, fact("business.name", "Someone Else")],
        "sites/x/source.tar.zst"
      ),
      5
    )
    expect(prefix(first).length).toBeGreaterThan(1000)
    expect(prefix(other)).toBe(prefix(first))
    expect(other).toContain("This is a revision")
  })

  it("keeps ADR-033 whole: no claim without a fact, the owner decides what is shown", () => {
    const text = instructions(brief([cleaning], "sites/x/source.tar.zst"), 20)
    expect(text).toContain("The site never shows a price")
    expect(text).toContain("business.proof is the only source")
    expect(text).toContain("It decides what the site shows")
    expect(text).toContain("never a fact")
  })
})

describe("the pack voice slot", () => {
  const packs = { legal: ["- Plain words, no jargon."] }

  it("is the industry's own notes and nothing for one without a pack", () => {
    expect(industryOf([legal])).toBe("legal")
    expect(packVoice([legal], packs)).toEqual(packs.legal)
    expect(packVoice([cleaning], packs)).toEqual([])
    expect(
      packVoice(
        [fact("business.industry", { name: "X", category: null })],
        packs
      )
    ).toEqual([])
    expect(packVoice([], packs)).toEqual([])
  })

  it("carries the cleaning pack's notes and none for an industry without a pack", () => {
    expect(packVoice([cleaning]).length).toBeGreaterThan(0)
    expect(instructions(brief([cleaning]), 20)).toContain("Industry pack")
    const other = fact("business.industry", { name: "X", category: null })
    expect(instructions(brief([other]), 20)).not.toContain("Industry pack")
  })
})

const fanPlan = fallbackBlueprint({ facts: [cleaning], recent: [] })
const planned = { ...brief([cleaning]), blueprint: fanPlan }

describe("the parallel first build", () => {
  it("gives every site field to one owner at most, the copy writer's to no page", () => {
    const owned = [
      ...pageTasks(fanPlan).flatMap((t) => t.fields),
      ...copyFields(fanPlan),
    ]
    expect(owned.length).toBeGreaterThan(0)
    expect(new Set(owned).size).toBe(owned.length)
    expect(copyFields(fanPlan)).toContain("homeTitle")
    expect(copyFields(fanPlan)).not.toContain("serviceTitle")
    expect([...new Set(pageTasks(fanPlan).map((t) => t.page))]).toEqual(
      fanPlan.pages.map((p) => p.page)
    )
    // One task per service page, each owning only its own service's fields.
    const services = pageTasks(fanPlan, 3).filter((t) => t.page === "service")
    expect(services.map((t) => t.service)).toEqual([1, 2, 3])
    expect(services[1]?.fields).toEqual(
      expect.arrayContaining([
        "service2Heading",
        "service2Title",
        "service2Detail",
        "service2Faq4Answer",
        "service2CtaBody",
      ])
    )
    expect(services[1]?.fields.every((f) => f.startsWith("service2"))).toBe(
      true
    )
  })

  it("gives every section heading the copy gate reads to a writer, and the brief to all of them", () => {
    const owned = new Set([
      ...pageTasks(fanPlan).flatMap((t) => t.fields),
      ...copyFields(fanPlan),
    ])
    const home = fanPlan.pages.find((p) => p.page === "home")
    const kinds = new Set(home?.sections.map((s) => s.kind))
    const heads: Record<string, string> = {
      service_cards: "serviceCardsHeading",
      value_props: "valuePropsHeading",
      steps: "stepsHeading",
      about: "homeAboutHeading",
      service_area: "homeAreaHeading",
      faq: "faqHeading",
    }
    for (const [kind, field] of Object.entries(heads))
      if (kinds.has(kind as never)) expect(owned, field).toContain(field)
    for (const text of [
      pageInstructions(planned),
      copyInstructions(planned),
      instructions(planned, 20),
    ]) {
      for (const line of COPY_BRIEF) expect(text).toContain(line)
    }
    // The brief quotes the gate's ranges, so the two cannot drift.
    const joined = COPY_BRIEF.join(" ")
    for (const { aim } of Object.values(COPY_WORDS))
      expect(joined).toContain(`${aim[0]} to ${aim[1]} words`)
  })

  it("sends at most four tasks a turn, every page once and the copy writer once", () => {
    const groups = taskGroups(fanPlan, 5)
    expect(groups.every((g) => g.length <= FAN_OUT)).toBe(true)
    const all = groups.flat()
    expect(all.filter((t) => t.agent === "copy")).toHaveLength(1)
    const pages = all
      .filter((t) => t.agent === "page")
      .map((t) => pageOfPrompt(t.prompt))
    expect(pages.filter((p) => p !== "service")).toEqual(
      fanPlan.pages.map((p) => p.page).filter((p) => p !== "service")
    )
    // Five service pages, in groups after every other task, so each reads
    // the name the home page's builder wrote.
    expect(pages.filter((p) => p === "service")).toHaveLength(5)
    const firstService = groups.findIndex((g) =>
      g.some((t) => pageOfPrompt(t.prompt) === "service")
    )
    expect(
      groups
        .slice(firstService)
        .flat()
        .every((t) => pageOfPrompt(t.prompt) === "service")
    ).toBe(true)
  })

  it("tells a planned first build's lead to fan out, and no one else", () => {
    const text = instructions(planned, 20)
    for (const line of leadLines(planned, fanPlan)) expect(text).toContain(line)
    expect(text).toContain("<use_parallel_tool_calls>")
    expect(instructions({ ...planned, restore_key: "k" }, 20)).not.toContain(
      "<use_parallel_tool_calls>"
    )
    expect(instructions(brief([cleaning]), 20)).not.toContain("task agent")
  })

  it("gives every page builder the same instructions, the facts and the plan included", () => {
    const text = pageInstructions(planned)
    expect(text).toBe(pageInstructions(planned))
    expect(text).toContain("Blueprint, the plan the owner approved")
    expect(text).toContain("Canonical facts")
    expect(text).not.toContain("ask_chief for the first missing")
  })

  it("has the copy writer write its fields in one edit and stop, not draft, count and re-edit", () => {
    const text = copyInstructions(planned)
    expect(text).toContain(COPY_WRITER_RULES)
    expect(text).toContain("Write all your fields in one edit call")
    expect(text).toContain("Never count characters")
    expect(text).toContain("stop and write the summary")
    // Its fields are empty lines it can anchor on, so it is not sent to read the file first.
    expect(text).not.toContain("Read src/site-config.ts and the components")
    expect(pageInstructions(planned)).toContain(
      "Read src/site-config.ts and the components"
    )
  })

  it("quotes the copy check's own ranges to the copy writer", () => {
    const source = readFileSync(
      new URL(
        "../../../packages/starter-site/src/copy-check.ts",
        import.meta.url
      ),
      "utf8"
    )
    const range = (name: string) => {
      const [m] = source.matchAll(
        new RegExp(`${name} = \\{ min: (\\d+), max: (\\d+) \\}`, "g")
      )
      if (!m) throw new Error(`${name} is not in copy-check.ts`)
      return `${m[1]} to ${m[2]}`
    }
    expect(COPY_WRITER_RULES).toContain(range("TITLE_CHARS"))
    expect(COPY_WRITER_RULES).toContain(range("DESCRIPTION_CHARS"))
  })
})

describe("the section lane's short prompt", () => {
  const revise = {
    ...brief([cleaning], "sites/x/source.tar.zst"),
    role: "quick_section" as const,
  }
  const withPlan = { ...revise, site_plan: fanPlan }

  it("is a third smaller than the full instructions, which it measures against", () => {
    const full = instructions(withPlan, 20).length
    const short = sectionInstructions(withPlan, 20).length
    console.info(`section prompt: ${full} chars before, ${short} after`)
    // The claim rules (about 7k chars) stay by design; the directions, components and design rules go.
    expect(short).toBeLessThan(full * 0.7)
  })

  it("drops the design material and keeps every rule that guards a claim", () => {
    const text = sectionInstructions(withPlan, 20)
    expect(text).not.toContain("Design rules")
    expect(text).not.toContain("Design directions:")
    expect(text).not.toContain("Components (name, file, props, never):")
    expect(text).not.toContain("Industry pack")
    expect(text).toContain("The site never shows a price")
    expect(text).toContain("business.proof is the only source")
    expect(text).toContain("Canonical facts")
    expect(text).toContain("Site map")
    expect(text).toContain("This is a revision")
  })

  it("lists the variants, then the latest plan's page order and each section's purpose", () => {
    const text = sectionInstructions(withPlan, 20)
    expect(text).toContain("  - hero: wash, split_arch")
    const [first] = fanPlan.pages
    const section = first?.sections[0]
    expect(text).toContain(
      `  - ${first?.page}: ${first?.sections.map((s) => `${s.kind} (${s.variant})`).join(", ")}`
    )
    expect(text).toContain(
      `  - ${first?.page} ${section?.kind}: ${section?.purpose}`
    )
    expect(text).not.toContain("Blueprint, the plan the owner approved")
  })

  it("lists the variants alone for a site built before planning", () => {
    const text = sectionInstructions(revise, 20)
    expect(text).toContain("  - faq: split, stacked")
    expect(text).not.toContain("The site as last planned")
  })
})
