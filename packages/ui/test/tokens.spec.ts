import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"

const UI = fileURLToPath(new URL("..", import.meta.url))

/** The custom property names declared inside one top-level rule. */
function declared(css: string, selector: string): string[] {
  const open = css.indexOf(`${selector} {`)
  if (open === -1) return []
  const body = css.slice(open, css.indexOf("}", open))
  return [...body.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((match) => match[1])
}

// A second package, as a consumer outside this one sees it: its own
// package.json, @workspace/ui linked into its node_modules the way pnpm links
// a workspace dependency, and the file reached through the export map rather
// than by path. No browser: what the import carries is the question.
test("a second package gets the tokens and none of the app's Tailwind", () => {
  const fixture = mkdtempSync(join(tmpdir(), "reme-tokens-consumer-"))
  try {
    mkdirSync(join(fixture, "node_modules/@workspace"), { recursive: true })
    symlinkSync(UI, join(fixture, "node_modules/@workspace/ui"), "dir")
    writeFileSync(
      join(fixture, "package.json"),
      JSON.stringify({
        name: "tokens-consumer",
        private: true,
        dependencies: { "@workspace/ui": "workspace:*" },
      })
    )

    const resolved = createRequire(join(fixture, "package.json")).resolve(
      "@workspace/ui/tokens.css"
    )
    const css = readFileSync(resolved, "utf8")

    expect(declared(css, ":root")).toHaveLength(30)
    expect(declared(css, ".dark")).toHaveLength(27)
    // Any of these would hand the consumer Tailwind, shadcn's preset or the
    // `@source "../../../apps/**"` scan that globals.css carries.
    expect(css).not.toMatch(
      /@import|@source|@theme|@tailwind|@plugin|@custom-variant|@apply/
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
