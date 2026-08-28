#!/usr/bin/env node

// Asserts that phosphor is the only icon library in the tree.
//
// The decision reads "one icon library in the tree, and lint says so". Lint did
// not say so. Biome's noRestrictedImports would need the same pattern repeated
// in every override block, because an override replaces rather than merges, and
// the rule as written is about dependencies rather than imports: lucide-react
// never enters a package.json. So check the manifests, which is the thing the
// rule actually names.

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const BANNED = "lucide-react"

// git ls-files rather than a walk, so node_modules and ignored paths are out by
// construction and a vendored copy under a gitignored directory is not our
// problem until someone commits it.
const manifests = execFileSync("git", ["ls-files", "*package.json"], {
  cwd: ROOT,
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean)

const offenders = manifests.filter((path) => {
  const pkg = JSON.parse(readFileSync(new URL(path, `file://${ROOT}/`), "utf8"))
  return [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ].some((field) => pkg[field] && BANNED in pkg[field])
})

if (offenders.length > 0) {
  console.error(
    `${BANNED} is in ${offenders.length} manifest(s). phosphor is the only icon\n` +
      "library here, and a vendor file importing lucide is repointed on the way\n" +
      "into packages/ui rather than bringing its library with it.\n"
  )
  for (const path of offenders) console.error(`  ${path}`)
  process.exit(1)
}

console.log(`icon library: ${manifests.length} manifests, no ${BANNED}`)
