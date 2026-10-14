import { existsSync, readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"

const read = (path: string) => readFileSync(new URL(path, import.meta.url))
const json = (path: string) => JSON.parse(read(path).toString("utf8"))

describe("the toolchain", () => {
  // The Developer builds this site with only infra/sandbox/astro's
  // node_modules, so a dependency that file does not name fails there and
  // nowhere here.
  test("names exactly the sandbox image's dependencies and versions", () => {
    const own = json("../package.json")
    const sandbox = json("../../../infra/sandbox/astro/package.json")

    expect(own.dependencies).toEqual(sandbox.dependencies)
    for (const name of Object.keys(sandbox.devDependencies)) {
      expect(own.devDependencies[name], name).toBe(
        sandbox.devDependencies[name]
      )
    }
  })

  // node_modules links to the image's read-only /opt/astro: a font pair the
  // image never built failed with ENOENT in node_modules/.astro/fonts.
  test("keeps Astro's and Vite's caches out of node_modules and git", async () => {
    const config = (await import("../astro.config.mjs")).default
    const ignored = read("../.gitignore").toString("utf8").split("\n")
    for (const dir of [config.cacheDir, config.vite?.cacheDir]) {
      expect(dir, "cacheDir unset").toBeTypeOf("string")
      const name = String(dir).replace(/^\.\//, "")
      expect(name).not.toMatch(/node_modules/)
      expect(ignored).toContain(`${name}/`)
    }
  })

  test("carries the tokens byte for byte", () => {
    const copy = read("../src/styles/tokens.css")
    const source = read("../../ui/src/styles/tokens.css")
    expect(
      copy.equals(source),
      "src/styles/tokens.css differs from packages/ui. From the repo root run: " +
        "cp packages/ui/src/styles/tokens.css packages/starter-site/src/styles/tokens.css"
    ).toBe(true)
  })
})

describe("the build", () => {
  for (const page of ["index.html", "404.html"]) {
    test(`emits dist/${page}`, () => {
      expect(
        existsSync(new URL(`../dist/${page}`, import.meta.url)),
        "run astro build first; `pnpm test` in this package does"
      ).toBe(true)
    })
  }
})
