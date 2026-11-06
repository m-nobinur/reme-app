import { readdirSync, readFileSync } from "node:fs"
import { SkillName, SkillViewOutput } from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import {
  indexOf,
  PROCEDURES,
  procedure,
  readSkillFile,
  SKILL_BUDGET,
  SOUL,
  scheduledBy,
  skillsFor,
} from "../src/index.ts"

const corrections = {
  lines: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      staff: "developer" as const,
      text: "Never use stock photos on my site.",
      at: "2026-10-30T09:00:00.000Z",
    },
  ],
}

const ROOT = new URL("../cos/", import.meta.url)
const dirs = readdirSync(ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)

describe("the soul", () => {
  it("is two short paragraphs, plain, with no examples and no dashes", () => {
    expect(SOUL.split("\n\n")).toHaveLength(2)
    expect(SOUL.length).toBeLessThan(1_200)
    expect(SOUL).not.toMatch(/[\u2013\u2014]|such as|for example|"/)
    expect(SOUL).toContain("they and them mean the owner")
  })
})

describe("skill files", () => {
  it("bundles every skill directory, and only those", () => {
    expect(PROCEDURES.map((p) => p.name).sort()).toEqual([...dirs].sort())
  })

  it.each(dirs)("%s is a well-formed SKILL.md", (dir) => {
    const text = readFileSync(new URL(`${dir}/SKILL.md`, ROOT), "utf8")
    const refs = readdirSync(new URL(`${dir}/`, ROOT)).includes("references")
      ? readdirSync(new URL(`${dir}/references/`, ROOT))
      : []
    const read = readSkillFile(
      text,
      Object.fromEntries(
        refs.map((f) => [
          f.replace(/\.md$/, ""),
          readFileSync(new URL(`${dir}/references/${f}`, ROOT), "utf8"),
        ])
      )
    )
    expect(read.name).toBe(dir)
    expect(SkillName.safeParse(read.name).success).toBe(true)
    expect(read.description).toMatch(/^Use (when|for|before) .+\.$/)
    expect(read.description.length).toBeLessThanOrEqual(90)
    expect(read.expertise.split(" ").length).toBeLessThanOrEqual(2)
    expect(read.status).toHaveLength(2)
    for (const line of read.status) {
      expect(line.length).toBeLessThanOrEqual(50)
      expect(line).toMatch(/^[A-Z][^.!?]*$/)
    }
    expect(read.body).toMatch(
      /^# .+\n\n.+\n\n## When to use\n[\s\S]+\n## Procedure\n/
    )
    for (const part of read.parts) expect(part.when).toMatch(/^Read it when /)
    expect(read.parts.map((p) => p.name).sort()).toEqual(
      refs.map((f) => f.replace(/\.md$/, "")).sort()
    )
  })

  it("refuses a listed part with no file, and a file nobody lists", () => {
    const text = readFileSync(new URL("google-search/SKILL.md", ROOT), "utf8")
    expect(() => readSkillFile(text, { connect: "x" })).toThrow(
      /lists performance with no file/
    )
    expect(() =>
      readSkillFile(text, { connect: "x", performance: "y", stray: "z" })
    ).toThrow(/unlisted parts stray/)
  })
})

describe("skills", () => {
  it("keeps the index in the core and every skill within its budget", () => {
    expect(indexOf(PROCEDURES).join("\n").length).toBeLessThanOrEqual(
      SKILL_BUDGET.index
    )
    for (const p of PROCEDURES) {
      expect(p.body.length, p.name).toBeLessThanOrEqual(SKILL_BUDGET.core)
      for (const part of p.parts)
        expect(part.body.length, `${p.name}/${part.name}`).toBeLessThanOrEqual(
          SKILL_BUDGET.part
        )
    }
  })

  it.each(PROCEDURES)("$name fits skill_view's output", (p) => {
    expect(
      SkillViewOutput.safeParse({
        outcome: "skill",
        name: p.name,
        body: p.body,
        parts: p.parts.map((x) => x.name),
        status: p.status[0],
      }).success
    ).toBe(true)
    for (const part of p.parts) {
      expect(
        SkillViewOutput.safeParse({
          outcome: "skill",
          name: p.name,
          part: part.name,
          body: part.body,
          status: p.status[0],
        }).success
      ).toBe(true)
    }
  })

  it("lists the CoS's procedures and none of the Developer's corrections", () => {
    const cos = skillsFor("cos", corrections)
    expect(cos.map((s) => s.name)).toEqual([
      "web-address",
      "google-search",
      "site-change",
      "builds",
      "reviews",
      "reminders-and-time",
      "quotes-and-prices",
      "quote-reply",
      "review-reply",
      "weekly-review",
    ])
    expect(indexOf(cos)[0]).toBe(
      "- web-address (domains): Use when they talk about a domain or their web address."
    )
    expect(indexOf(cos).join("\n")).not.toContain("stock photos")
  })

  it("gives the Developer its corrections", () => {
    const developer = skillsFor("developer", corrections)
    expect(developer).toEqual([
      expect.objectContaining({
        kind: "correction",
        scope: "developer",
        body: "Never use stock photos on my site.",
      }),
    ])
  })

  it("asks whether they have a domain before anything else, and never guesses one", () => {
    const skill = procedure("cos", "web-address")
    const part = (name: string) =>
      skill?.parts.find((p) => p.name === name)?.body ?? ""
    const [first] = skill?.body.split("## Procedure\n")[1]?.split("\n") ?? []
    expect(first).toMatch(/^1\. Ask first\. /)
    expect(first).toMatch(/one short question: do they already have a domain/)
    expect(first).toContain("NEVER assume they own one, NEVER guess")
    expect(first).toContain("do not read connect-own until they say")
    expect(skill?.body).toContain("never a name made from theirs")
    expect(part("buy-new")).toMatch(
      /"I'll skip the domain for now"\), call put_off with kind address, then reply once, in one line/
    )
    expect(part("buy-new")).toContain("Never quote dollars.")
    expect(part("bought-elsewhere")).toMatch(
      /registry doesn't show it yet, your reply says so/
    )
    expect(part("bought-elsewhere")).toContain(
      "do NOT call inspect_domain, check_domain or domain_bought again in this reply"
    )
    expect(part("bought-elsewhere")).toMatch(
      /"I haven't bought <name> yet"\), reply in three short sentences/
    )
    expect(part("bought-elsewhere")).toContain(
      'opening with "However, I recommend having your own domain"'
    )
    expect(part("bought-elsewhere")).toContain(
      "whether they'd like to see the domain names again"
    )
    expect(part("bought-elsewhere")).toContain(
      "Do not infer that silence means it's bought."
    )
  })

  it("finds a procedure only in its own scope", () => {
    expect(procedure("cos", "review-reply")?.name).toBe("review-reply")
    expect(procedure("developer", "review-reply")).toBeNull()
    expect(procedure("cos", "nothing")).toBeNull()
  })

  it("runs the weekly review on the weekly_report job, Monday at 8", () => {
    expect(scheduledBy("weekly_report")).toMatchObject({
      name: "weekly-review",
      schedule: { kind: "weekly_report", rule: "0 8 * * 1" },
    })
    expect(scheduledBy("heartbeat")).toBeNull()
    expect(procedure("cos", "weekly-review")?.schedule).toEqual({
      kind: "weekly_report",
      rule: "0 8 * * 1",
    })
  })
})
