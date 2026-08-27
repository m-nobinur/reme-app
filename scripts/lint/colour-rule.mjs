#!/usr/bin/env node
// Asserts that the no-hardcoded-colours GritQL plugin is loaded and matching.
//
// It exists because the plugin can fail open in silence. A regex Biome cannot
// parse is reported at info level, which `--error-on-warnings` does not fail on;
// a regex that parses but matches nothing produces no output at all. Either way
// `pnpm lint` exits 0 and the tree looks clean. The rule shipped for its whole
// first life missing `className="bg-red-500"`, the most ordinary violation there
// is, and nothing said so.
//
// So: lint a fixture with known answers and compare. Every MUST line has to be
// flagged and every OK line has to be left alone. The fixture is written to a
// temporary directory rather than kept in the tree, because a file the rule is
// supposed to reject cannot also live somewhere `pnpm lint` will walk.

import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))

// The fixture lines live in a .txt beside this file, not in this array. A file
// full of the exact strings the rule must reject cannot also sit somewhere
// `pnpm lint` walks, and escaping them into pieces here would test a different
// string from the one a person would write. Each line is `MUST ` or `OK   `
// followed by the source; the markers are the same width, so a line number in
// the fixture is a line number in what Biome reads.
const FIXTURE = readFileSync(
  new URL("./colour-rule-fixture.txt", import.meta.url),
  "utf8"
)
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => ({
    mustFlag: line.startsWith("MUST"),
    source: line.slice(5),
  }))

const dir = mkdtempSync(join(tmpdir(), "reme-colour-rule-"))
const file = join(dir, "fixture.tsx")
writeFileSync(file, `${FIXTURE.map((c) => c.source).join("\n")}\n`)

let output = ""
try {
  output = execFileSync(
    join(ROOT, "node_modules/.bin/biome"),
    [
      "check",
      `--config-path=${ROOT}`,
      "--reporter=json",
      // Only this plugin. The fixture is deliberately bad code and would trip
      // half the rule set otherwise.
      "--only=plugin",
      file,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
  )
} catch (error) {
  // Biome exits non-zero when it reports errors, which is the expected case.
  output = error.stdout ?? ""
} finally {
  rmSync(dir, { recursive: true, force: true })
}

const json = output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1)
if (!json) {
  console.error("colour rule: biome produced no JSON report.\n", output)
  process.exit(1)
}

const flagged = new Set(
  JSON.parse(json)
    .diagnostics.filter((d) => d.message.startsWith("Hard-coded colour"))
    .map((d) => d.location.start.line)
)

const wrong = FIXTURE.filter(
  (testCase, index) => flagged.has(index + 1) !== testCase.mustFlag
)

if (wrong.length > 0) {
  console.error(
    "The no-hardcoded-colours plugin is not doing its job.\n" +
      "Check scripts/lint/no-hardcoded-colours.grit; a regex Biome cannot parse\n" +
      "is reported at info level and does not fail the build on its own.\n"
  )
  for (const { source, mustFlag } of wrong) {
    console.error(`  ${mustFlag ? "missed" : "wrongly flagged"}: ${source}`)
  }
  process.exit(1)
}

console.log(`colour rule: ${FIXTURE.length} fixture lines, all as expected`)
