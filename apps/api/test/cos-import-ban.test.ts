import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * The Biome rule that keeps `conversationMessages` out of `apps/api/src/cos`
 * (ADR-034), run with the repo's own config on probe files. The probes live
 * in a temporary copy of the tree's layout, because a file the rule must
 * reject cannot sit where `pnpm lint` walks.
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url))
const BANNED =
  'import { conversationMessages } from "@workspace/db"\n\nexport const x = conversationMessages\n'
const ALLOWED =
  'import { events } from "@workspace/db"\n\nexport const x = events\n'

let dir = ""

/** The files under `dir` the import rule flags, as paths from `dir`. */
function flagged(): string[] {
  let output = ""
  try {
    output = execFileSync(
      join(ROOT, "node_modules/.bin/biome"),
      [
        "lint",
        "--vcs-enabled=false",
        "--only=style/noRestrictedImports",
        "--reporter=json",
        "apps",
      ],
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    )
  } catch (error) {
    // Biome exits non-zero when it reports an error, the case under test.
    output = (error as { stdout?: string }).stdout ?? ""
  }
  const json = output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1)
  const report = JSON.parse(json) as {
    diagnostics: { category: string; location: { path: string } }[]
  }
  return report.diagnostics
    .filter((d) => d.category === "lint/style/noRestrictedImports")
    .map((d) => d.location.path)
    .sort((a, b) => a.localeCompare(b))
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "reme-cos-ban-"))
  cpSync(join(ROOT, "biome.jsonc"), join(dir, "biome.jsonc"))
  const grit = "scripts/lint/no-hardcoded-colours.grit"
  mkdirSync(dirname(join(dir, grit)), { recursive: true })
  cpSync(join(ROOT, grit), join(dir, grit))
  const probes = {
    "apps/api/src/cos/banned.ts": BANNED,
    "apps/api/src/cos/allowed.ts": ALLOWED,
    "apps/api/src/outside.ts": BANNED,
  }
  for (const [path, source] of Object.entries(probes)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), source)
  }
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("the conversationMessages ban in cos/", () => {
  it("fails lint on the import inside cos/ and nowhere else", () => {
    expect(flagged()).toEqual(["apps/api/src/cos/banned.ts"])
  })
})
