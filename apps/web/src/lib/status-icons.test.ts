import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { STATE_MARKS } from "@workspace/ui/lib/status-icons"
import { expect, it } from "vitest"

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url))
const REGISTRY = "packages/ui/src/lib/status-icons.ts"

/** Pictures the list retired: each meant a state another mark now carries. */
const RETIRED = [
  "ProhibitIcon",
  "WarningIcon",
  "SealCheckIcon",
  "CircleHalfIcon",
  "HourglassIcon",
  "HourglassMediumIcon",
]

/** The landing page draws the app in miniature, at its own sizes. */
const PICTURES = /\/landing(-visuals)?\.tsx$/

const sources = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : []
  })

const phosphorImports = (source: string) =>
  [
    ...source.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*"@phosphor-icons\/react"/g
    ),
  ]
    .flatMap((match) => (match[1] ?? "").split(","))
    .map((name) => name.trim().replace(/^type\s+/, ""))

it("draws every state icon from the icon list, never from phosphor", () => {
  const owned = new Set([
    ...Object.values(STATE_MARKS).flatMap((mark) =>
      "Icon" in mark && mark.Icon.displayName ? [mark.Icon.displayName] : []
    ),
    ...RETIRED,
  ])
  expect(owned).toContain("CheckCircleIcon")
  const strays = ["packages/ui/src", "apps/web/src"]
    .flatMap(sources)
    .filter((path) => path !== REGISTRY && !PICTURES.test(path))
    .flatMap((path) =>
      phosphorImports(readFileSync(join(ROOT, path), "utf8"))
        .filter((name) => owned.has(name))
        .map((name) => `${relative(".", path)}: ${name}`)
    )
  expect(strays).toEqual([])
})
