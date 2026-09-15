import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { REPO_MAP_MAX_CHARS, repoMap } from "../src/repo-map.ts"

const root = fileURLToPath(
  new URL("../../../fixtures/sites/starter/", import.meta.url)
)
const starter: Record<string, string> = Object.fromEntries(
  execSync("git ls-files .", { cwd: root, encoding: "utf8" })
    .trim()
    .split("\n")
    .map((path) => [path, readFileSync(`${root}${path}`, "utf8")])
)

describe("the repository map", () => {
  const map = repoMap(starter)
  const lines = map.split("\n")

  it("lists every file of the starter in path order", () => {
    expect(lines).toHaveLength(Object.keys(starter).length)
    expect(lines.map((l) => l.split(" ")[0])).toEqual(
      Object.keys(starter).sort()
    )
  })

  it("says what each file exports, takes, uses and reads", () => {
    expect(map).toContain(
      "src/site-config.ts (752 B): exports site {name, tagline, phone, email, weekdayHours, serviceArea, standardCleanHourly}"
    )
    expect(map).toContain(
      "src/layouts/Base.astro (935 B): props {title: string}; uses site; reads site.name, site.serviceArea"
    )
    expect(map).toContain(
      "src/pages/contact.astro (360 B): uses Base, site; reads site.phone, site.email, site.weekdayHours"
    )
  })

  it("is the same map whatever order the files arrive in", () => {
    const reversed = Object.fromEntries(Object.entries(starter).reverse())
    expect(repoMap(reversed)).toBe(map)
  })

  it("stops at the cap and names what it left out", () => {
    const many = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [
        `src/components/Component${String(i).padStart(3, "0")}.astro`,
        "---\ninterface Props {\n  title: string\n}\n---\n",
      ])
    )
    const cut = repoMap(many)
    expect(cut.length).toBeLessThanOrEqual(REPO_MAP_MAX_CHARS)
    const notice = cut.split("\n").at(-1) ?? ""
    expect(notice).toMatch(
      /^\[Map cut at 4000 characters: \d+ files not listed/
    )
    const listed = cut.split("\n").length - 1
    expect(notice).toContain(
      `src/components/Component${String(listed).padStart(3, "0")}.astro`
    )
  })
})
