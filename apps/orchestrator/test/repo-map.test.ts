import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { ComponentManifest } from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import { manifestDigest, REPO_MAP_MAX_CHARS, repoMap } from "../src/repo-map.ts"

const root = fileURLToPath(new URL("./fixtures/starter/", import.meta.url))
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
      "src/site-config.ts (747 B): exports site {name, tagline, phone, email, weekdayHours, serviceArea, offerings}"
    )
    expect(map).toContain(
      "src/layouts/Base.astro (935 B): props {title: string}; uses site; reads site.name, site.serviceArea"
    )
    expect(map).toContain(
      "src/pages/contact.astro (360 B): uses Base, site; reads site.phone, site.email, site.weekdayHours"
    )
  })

  it("gives the component manifests one line between them", () => {
    const withManifests = {
      ...starter,
      "src/components/Hero/Hero.astro": "---\n---\n",
      "src/components/Hero/manifest.yaml": "component: Hero\n",
      "src/components/Steps/Steps.astro": "---\n---\n",
      "src/components/Steps/manifest.yaml": "component: Steps\n",
    }
    const mapped = repoMap(withManifests).split("\n")
    expect(mapped.filter((l) => l.includes("manifest.yaml"))).toEqual([
      "src/components/<Name>/manifest.yaml (2 files): one beside each component, with its constraints and examples",
    ])
    expect(mapped).toHaveLength(Object.keys(withManifests).length - 1)
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
      /^\[Map cut at 10000 characters: \d+ files not listed/
    )
    const listed = cut.split("\n").length - 1
    expect(notice).toContain(
      `src/components/Component${String(listed).padStart(3, "0")}.astro`
    )
  })
})

describe("the manifest digest", () => {
  const manifest = (
    component: string,
    extra: Partial<ComponentManifest> = {}
  ): ComponentManifest => ({
    component,
    path: `src/components/${component}.astro`,
    summary: `${component} summary`,
    props: [
      { name: "phone", type: "string", required: false, description: "d" },
      { name: "size", type: '"sm" | "lg"', required: true, description: "d" },
    ],
    constraints: [],
    examples: [`<${component} />`],
    forbidden: ["a placeholder when the phone is empty"],
    source: "generated",
    ...extra,
  })

  it("gives one line per component with its props and forbidden uses", () => {
    expect(manifestDigest([manifest("ContactDetails")])).toBe(
      'ContactDetails (src/components/ContactDetails.astro): props phone?: string, size: "sm" | "lg"; never: a placeholder when the phone is empty'
    )
  })

  it("lists components in path order whatever order they arrive in", () => {
    const lines = manifestDigest([manifest("Zeta"), manifest("Alpha")]).split(
      "\n"
    )
    expect(lines.map((l) => l.split(" ")[0])).toEqual(["Alpha", "Zeta"])
  })

  it("throws past the cap rather than hiding a forbidden use", () => {
    const many = Array.from({ length: 60 }, (_, i) => manifest(`Component${i}`))
    expect(() => manifestDigest(many)).toThrow(/6000 characters/)
  })
})
