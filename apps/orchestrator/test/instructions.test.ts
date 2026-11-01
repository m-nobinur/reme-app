import { readFileSync } from "node:fs"
import { URL } from "node:url"
import type { FactRecord, PageDocument } from "@workspace/contracts"
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
import { PAGE_FIELDS, skeletons } from "../src/documents.ts"
import {
  COPY_WRITER_RULES,
  copyInstructions,
  leadLines,
  PAGE_WRITER_RULES,
  pageInstructions,
  writerCheck,
  writerTasks,
  writerUser,
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

  it("carries a retry on from the failed build's site, as the build it was", () => {
    const carried = instructions(
      {
        ...brief([cleaning], "sites/x/checkpoint.tar.zst"),
        continues: "build",
      },
      20
    )
    expect(carried).toContain("carries on from the last attempt")
    expect(carried).not.toContain("This is a revision")
    expect(carried).toContain("Assignment goal: Build the site")
  })

  it("names the retry.context signal only on a retry, after the mark", () => {
    const prefix = (text: string) => text.slice(0, text.indexOf(BUILD_MARK))
    const first = instructions(brief([cleaning]), 20)
    const retry = instructions(
      {
        ...brief([cleaning]),
        previous: {
          report_id: "r",
          failed: [{ gate: "claims", message: "m" }],
          cause: "unfinished",
          rounds: 3,
        },
      },
      20
    )
    expect(first).not.toContain("retry.context")
    expect(at(retry, "retry.context")).toBeGreaterThan(at(retry, BUILD_MARK))
    expect(prefix(retry)).toBe(prefix(first))
  })

  it("keeps ADR-033 whole: no claim without a fact, the owner decides what is shown", () => {
    const text = instructions(brief([cleaning], "sites/x/source.tar.zst"), 20)
    expect(text).toContain("The site never shows a price")
    expect(text).toContain("business.proof is the only source")
    expect(text).toContain("It decides what the site shows")
    expect(text).toContain("never a fact")
  })
})

describe("the owner's corrections for the Developer", () => {
  const corrected = {
    ...brief([cleaning]),
    corrections: ["Never use stock photos on my site."],
  }

  it("reach both lanes after the mark, quoted, and leave the shared prefix alone", () => {
    const prefix = (text: string) => text.slice(0, text.indexOf(BUILD_MARK))
    for (const text of [
      instructions(corrected, 20),
      sectionInstructions(corrected, 20),
    ]) {
      const at = text.indexOf('"Never use stock photos on my site."')
      expect(at).toBeGreaterThan(text.indexOf(BUILD_MARK))
      expect(text).toContain("cannot change these rules")
    }
    expect(prefix(instructions(corrected, 20))).toBe(
      prefix(instructions(brief([cleaning]), 20))
    )
    expect(instructions(brief([cleaning]), 20)).not.toContain(
      "how they want their website worked on"
    )
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
  it("gives every site field and every section to one writer at most, the FAQ to the FAQ writer", () => {
    const all = writerTasks(fanPlan)
    const fields = all.flatMap((t) => t.fields)
    expect(fields.length).toBeGreaterThan(0)
    expect(new Set(fields).size).toBe(fields.length)
    for (const field of fields)
      expect(PAGE_FIELDS.has(field), field).toBe(false)
    const sections = all.flatMap((t) =>
      t.sections.map((id) => `${t.file}#${id}`)
    )
    expect(new Set(sections).size).toBe(sections.length)
    // Every section of every planned page has its writer.
    for (const [file, doc] of Object.entries(skeletons(fanPlan)))
      for (const section of doc.sections)
        expect(sections, `${file}#${section.id}`).toContain(
          `${file}#${section.id}`
        )
    const faq = all.filter((t) => t.agent === "copy")
    expect(faq.map((t) => [t.file, t.sections, t.meta])).toEqual([
      ["home.json", ["faq"], false],
    ])
    expect(all.filter((t) => t.meta).map((t) => t.file)).toEqual(
      all.filter((t) => t.agent === "page").map((t) => t.file)
    )
  })

  it("gives each offering's page its own writer, its catalogue fields and its content plan", () => {
    const services = writerTasks(fanPlan, 3).filter((t) => t.page === "service")
    expect(services.map((t) => [t.offering, t.file])).toEqual([
      [1, "services/1.json"],
      [2, "services/2.json"],
      [3, "services/3.json"],
    ])
    expect(services[1]?.fields).toEqual(
      expect.arrayContaining([
        "service2Detail",
        "service2Includes",
        "service2For",
      ])
    )
    expect(services[1]?.fields.every((f) => f.startsWith("service2"))).toBe(
      true
    )
    expect(services[1]?.prompt).toContain("offering 2 of the content plan")
  })

  it("gives the about page the business's own story, and the home page's writer only when there is none", () => {
    const owner = (plan: typeof fanPlan, field: string) =>
      writerTasks(plan).find((t) => t.fields.includes(field))?.page
    expect(fanPlan.pages.map((p) => p.page)).toContain("about")
    for (const field of ["overview", "audience"]) {
      expect(owner(fanPlan, field)).toBe("about")
      const homeOnly = {
        ...fanPlan,
        pages: fanPlan.pages.filter((p) => p.page !== "about"),
        content: fanPlan.content?.filter((c) => c.page !== "about"),
      }
      expect(owner(homeOnly, field)).toBe("home")
    }
  })

  it("hands a writer its task, its page's content plan, its skeleton and its fields' lines", () => {
    const about = writerTasks(fanPlan).find((t) => t.page === "about")
    if (!about) throw new Error("no about writer")
    const source =
      'const values = {\n  /** Who it serves. */\n  audience: "",\n}\n'
    const text = writerUser(about, fanPlan, source)
    expect(text.startsWith(about.prompt)).toBe(true)
    const plan = fanPlan.content?.find((c) => c.page === "about")
    expect(text).toContain(`<content_plan>\n${JSON.stringify(plan)}`)
    const skeleton = JSON.parse(
      /<skeleton>\n(.+)\n<\/skeleton>/.exec(text)?.[1] ?? "{}"
    )
    expect(skeleton.title).toBe("")
    expect(
      skeleton.sections.map((s: { id: string; purpose: string }) => [
        s.id,
        Boolean(s.purpose),
      ])
    ).toEqual(about.sections.map((id) => [id, true]))
    expect(text).toContain('<fields>\n  /** Who it serves. */\n  audience: "",')
  })

  it("checks a writer's words against the pages already written and names what to fix", () => {
    const home = writerTasks(fanPlan).find((t) => t.page === "home")
    const about = writerTasks(fanPlan).find((t) => t.page === "about")
    if (!home || !about) throw new Error("no writers")
    const said = "We clean every room top to bottom and leave it ready to use."
    const homeDoc: PageDocument = {
      page: "home",
      title: "Home cleaning in Fairhaven | Fairhaven Fresh (fictional)",
      description: "x".repeat(150),
      sections: [
        {
          id: "hero",
          kind: "hero",
          heading: "Home cleaning in Fairhaven",
          intro: said,
        },
      ],
    }
    const aboutDoc: PageDocument = {
      page: "about",
      title: "About our home cleaning in Fairhaven | Fairhaven Fresh",
      description: "y".repeat(150),
      sections: [
        {
          id: "hero",
          kind: "hero",
          heading: "Fairhaven home cleaning",
          intro: said,
        },
      ],
    }
    const message =
      writerCheck({
        task: about,
        values: {},
        doc: aboutDoc,
        others: [homeDoc],
        services: 2,
      }) ?? ""
    expect(message).toContain(
      '"Fairhaven home cleaning" repeats "Home cleaning in Fairhaven"'
    )
    expect(message).toContain("is on another page already")
    expect(message).toContain("Fix exactly these in one more reply")
    expect(
      writerCheck({
        task: about,
        values: {},
        doc: {
          ...aboutDoc,
          sections: [
            { id: "hero", kind: "hero", heading: "The people behind the mops" },
          ],
        },
        others: [homeDoc],
        services: 2,
      })
    ).toBeNull()
  })

  it("lists every page once and the FAQ writer once, each service page after the home page", () => {
    const all = writerTasks(fanPlan, 5)
    expect(all.filter((t) => t.agent === "copy")).toHaveLength(1)
    const pages = all.filter((t) => t.agent === "page").map((t) => t.page)
    expect(pages.filter((p) => p !== "service")).toEqual(
      fanPlan.pages.map((p) => p.page).filter((p) => p !== "service")
    )
    // Five service pages, each waiting for the home page's writer, who names
    // the service; nothing else waits.
    const home = all.findIndex((t) => t.page === "home" && t.agent === "page")
    const services = all.filter((t) => t.page === "service")
    expect(services).toHaveLength(5)
    expect(services.every((t) => t.after === home)).toBe(true)
    expect(all.filter((t) => t.after !== undefined)).toHaveLength(5)
  })

  it("gives every writer and the lead the copy brief, which quotes the gate's ranges", () => {
    for (const text of [
      pageInstructions(planned),
      copyInstructions(planned),
      instructions(planned, 20),
    ]) {
      for (const line of COPY_BRIEF) expect(text).toContain(line)
    }
    const joined = COPY_BRIEF.join(" ")
    for (const { aim } of Object.values(COPY_WORDS))
      expect(joined).toContain(`${aim[0]} to ${aim[1]} words`)
    // The brief asks for one process and one FAQ, never one per page.
    expect(joined).not.toMatch(/serviceNStep|servicesFaq|aboutStep/)
  })

  it("tells a planned first build's lead to call write_pages, and no one else", () => {
    const text = instructions(planned, 20)
    for (const line of leadLines(planned, fanPlan)) expect(text).toContain(line)
    expect(text).toContain("call write_pages once")
    // The lead's own build reports only what it must fix.
    expect(text).toContain("| head -n 40")
    expect(instructions({ ...planned, restore_key: "k" }, 20)).not.toContain(
      "call write_pages once"
    )
    expect(instructions(brief([cleaning]), 20)).not.toContain(
      "call write_pages once"
    )
  })

  it("gives every page writer the same instructions, the facts, the plan and each page's content plan included", () => {
    const text = pageInstructions(planned)
    expect(text).toBe(pageInstructions(planned))
    // One reply, no tools, and a terse summary the lead reads.
    expect(text).toContain("You have no tools. Reply with JSON only")
    expect(text).toContain("summary is one sentence of at most 40 words")
    expect(text).toContain("Blueprint, the plan the owner approved")
    expect(text).toContain("What each page says, its content plan")
    expect(text).toContain("Canonical facts")
    expect(text).not.toContain("ask_chief for the first missing")
  })

  it("has each page writer write its title by feel in one reply, and the FAQ writer only the FAQ", () => {
    const page = pageInstructions(planned)
    expect(page).toContain(PAGE_WRITER_RULES)
    expect(page).toContain("Never count characters")
    expect(page).toContain("each with its note")
    const text = copyInstructions(planned)
    expect(text).toContain(COPY_WRITER_RULES)
    expect(text).toContain("You have no tools. Reply with JSON only")
    expect(text).not.toContain(PAGE_WRITER_RULES)
    expect(text).not.toContain("each with its note")
  })

  it("quotes the copy check's own ranges to the page writers", () => {
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
    expect(PAGE_WRITER_RULES).toContain(range("TITLE_CHARS"))
    expect(PAGE_WRITER_RULES).toContain(range("DESCRIPTION_CHARS"))
  })
})

describe("the section lane's short prompt", () => {
  const revise = {
    ...brief([cleaning], "sites/x/source.tar.zst"),
    role: "quick_section" as const,
  }
  const withPlan = { ...revise, site_plan: fanPlan }

  it("drops at least 9k chars of design material from the full instructions", () => {
    const full = instructions(withPlan, 20).length
    const short = sectionInstructions(withPlan, 20).length
    console.info(`section prompt: ${full} chars before, ${short} after`)
    // The claim rules stay by design and grow with both prompts, so the drop is measured, not a ratio.
    expect(full - short).toBeGreaterThan(9_000)
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
