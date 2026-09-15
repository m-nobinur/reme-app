import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { digest, loadManifests, ROOT } from "../scripts/manifests"

const DIGEST_LIMIT = 3000

const loaded = loadManifests()
const problemsOf = (kind: string) =>
  loaded.problems
    .filter((problem) => problem.kind === kind)
    .map((problem) => problem.message)

describe("component manifests", () => {
  test("every component has exactly one manifest", () => {
    console.log(
      `manifests: ${loaded.components.length} components, ${loaded.manifests.length} manifests`
    )
    expect(problemsOf("missing")).toEqual([])
    expect(loaded.manifests.length).toBe(loaded.components.length)
  })

  test("every manifest parses as a ComponentManifest and names its own file", () => {
    expect(problemsOf("invalid")).toEqual([])
  })

  test("every manifest lists exactly the props its component declares", () => {
    expect(problemsOf("props")).toEqual([])
  })

  test("manifests.json is what the manifests regenerate to", () => {
    const committed = JSON.parse(
      readFileSync(join(ROOT, "manifests.json"), "utf8")
    )
    expect(
      committed,
      "manifests.json is stale. Run: pnpm --filter @workspace/starter-site manifests"
    ).toEqual(loaded.manifests)
  })

  test("the Developer's digest stays under its character budget", () => {
    const text = digest(loaded.manifests)
    console.log(
      `manifests: digest ${text.length} of ${DIGEST_LIMIT} characters`
    )
    expect(text.length).toBeLessThanOrEqual(DIGEST_LIMIT)
  })

  test("the starter keeps to a dozen components or fewer", () => {
    expect(loaded.components.length).toBeLessThanOrEqual(12)
  })
})
