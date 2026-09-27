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
/** A module that imports `from`, in the shape the rule reads. */
const importing = (from: string) =>
  `import { x } from "${from}"\n\nexport const y = x\n`

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
    "apps/api/src/cos/aliased.ts":
      'import { conversationMessages as rows } from "@workspace/db"\n\nexport const x = rows\n',
    "apps/api/src/cos/schema.ts":
      'import { conversationMessages } from "@workspace/db/schema"\n\nexport const x = conversationMessages\n',
    "apps/api/src/cos/schema-events.ts":
      'import { events } from "@workspace/db/schema"\n\nexport const x = events\n',
    "apps/api/src/outside.ts": BANNED,
    "apps/api/src/cos/chat.ts": importing("../chat.ts"),
    "apps/api/src/cos/chat-bare.ts": importing("../chat"),
    "apps/api/src/cos/conversations.ts": importing("../conversations.ts"),
    "apps/api/src/cos/http.ts": importing("../http.ts"),
    "apps/api/src/cos/owner.ts": importing("../owner.ts"),
    "apps/api/src/cos/org-bare.ts": importing("../org"),
    "apps/api/src/cos/changes.ts": importing("../changes.ts"),
    "apps/api/src/owner.ts": importing("./chat.ts"),
  }
  for (const [path, source] of Object.entries(probes)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), source)
  }
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("the conversationMessages ban in cos/", () => {
  it("fails lint on the table's import, and on the modules that import it, inside cos/ only", () => {
    expect(flagged()).toEqual([
      "apps/api/src/cos/aliased.ts",
      "apps/api/src/cos/banned.ts",
      "apps/api/src/cos/chat-bare.ts",
      "apps/api/src/cos/chat.ts",
      "apps/api/src/cos/conversations.ts",
      "apps/api/src/cos/org-bare.ts",
      "apps/api/src/cos/owner.ts",
      "apps/api/src/cos/schema.ts",
    ])
  })
})
