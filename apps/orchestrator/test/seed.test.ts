import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { STARTER_FILES } from "../src/seed.ts"

const repo = fileURLToPath(new URL("../../../", import.meta.url))
const tracked = (dir: string) =>
  execSync(`git ls-files ${dir}`, { cwd: repo, encoding: "utf8" })
    .trim()
    .split("\n")

describe("the seed", () => {
  it("is the starter-site package's config and src, and nothing else of it", () => {
    const expected = tracked("packages/starter-site")
      .map((path) => path.slice("packages/starter-site/".length))
      .filter(
        (path) =>
          path.startsWith("src/") ||
          ["astro.config.mjs", "tsconfig.json", ".gitignore"].includes(path)
      )
    expect(Object.keys(STARTER_FILES).sort()).toEqual(
      [...expected, "package.json"].sort()
    )
  })

  it("carries the files byte for byte, with the sandbox image's package.json", () => {
    for (const [path, content] of Object.entries(STARTER_FILES)) {
      const source =
        path === "package.json"
          ? "infra/sandbox/astro/package.json"
          : `packages/starter-site/${path}`
      expect(content, path).toBe(readFileSync(`${repo}${source}`, "utf8"))
    }
  })
})
