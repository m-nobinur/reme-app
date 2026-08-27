/**
 * Asserts that no server-side credential reaches anything a browser downloads.
 *
 * This is the whole of the control ADR-026 left behind. The rule it replaced
 * was "`WORKOS_API_KEY` lives in `apps/api` and nowhere else", which was a
 * placement rule standing in for the property we actually want. Both Workers
 * hold the key now, so the property has to be checked directly: it is a
 * server-side secret and it reaches no client bundle.
 *
 * What is scanned is `dist/client`, every file of it, as bytes. Not the source,
 * not an import graph: the question is what Cloudflare serves to a browser, and
 * the only honest answer is the built artefact. HTML, JavaScript, source maps
 * and anything else in there all count, because all of them are downloadable.
 *
 * Two kinds of finding, and the second matters as much as the first. A literal
 * secret value is the obvious leak. A *reference* — the string
 * `WORKOS_API_KEY`, or an `@workos-inc/node` import — means server code entered
 * the client graph, and the value is one build-time inline away from following
 * it. ADR-026 named that exact failure as the thing this check exists to catch.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Names that must not appear in a client asset. `WORKOS_CLIENT_ID` is
 * deliberately absent: it is public by design and appears in authorization
 * URLs.
 */
export const FORBIDDEN_NAMES = [
  "WORKOS_API_KEY",
  "WORKOS_COOKIE_PASSWORD",
  "@workos-inc/node",
]

/**
 * Shapes that are a secret whatever they are called. The WorkOS API key prefix
 * covers a key pasted in as a literal, which no name-based check would see.
 */
export const FORBIDDEN_PATTERNS = [
  { name: "a WorkOS API key", pattern: /sk_(test|live)_[A-Za-z0-9_-]{16,}/ },
]

/**
 * @param {Array<{ path: string, text: string }>} files
 * @param {string[]} values Literal secret values, when the scan knows them.
 * @returns {string[]} One line per finding. Empty means clean.
 */
export function scan(files, values = []) {
  const findings = []
  for (const file of files) {
    for (const name of FORBIDDEN_NAMES) {
      if (file.text.includes(name)) {
        findings.push(`${file.path}: contains ${name}`)
      }
    }
    for (const { name, pattern } of FORBIDDEN_PATTERNS) {
      if (pattern.test(file.text)) {
        findings.push(`${file.path}: contains what looks like ${name}`)
      }
    }
    for (const value of values) {
      // A short value would match half the alphabet; anything this length is a
      // real secret or a coincidence worth looking at either way.
      if (value.length >= 16 && file.text.includes(value)) {
        findings.push(`${file.path}: contains a live secret value`)
      }
    }
  }
  return findings
}

export function readClientAssets(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name)
      return { path, text: readFileSync(path, "latin1") }
    })
}

// Only when run directly, so the test can import `scan` without this firing.
if (process.argv[1]?.endsWith("secret-scan.mjs")) {
  const dir = new URL("../dist/client", import.meta.url).pathname

  let files
  try {
    files = readClientAssets(dir)
  } catch (error) {
    console.error(
      `secrets: cannot read ${dir}. ${error.message}\n` +
        "If the build is missing, run: pnpm build --filter web"
    )
    process.exit(1)
  }

  if (files.length === 0) {
    // An empty directory would pass every check while proving nothing, which
    // is the failure mode this repo has already been bitten by twice.
    console.error(
      `secrets: ${dir} holds no files. There is nothing to check, so this is a failure, not a pass.`
    )
    process.exit(1)
  }

  const values = ["WORKOS_API_KEY", "WORKOS_COOKIE_PASSWORD"]
    .map((name) => process.env[name])
    .filter((value) => typeof value === "string" && value.length > 0)

  const findings = scan(files, values)
  console.log(
    `secrets  ${files.length} client assets scanned` +
      (values.length > 0
        ? `, including ${values.length} live value(s)`
        : ", no live values in this environment")
  )
  if (findings.length > 0) {
    console.error(`\nsecrets: a credential reached the client bundle.`)
    for (const finding of findings) {
      console.error(`  ${finding}`)
    }
    process.exit(1)
  }
  console.log("secrets  clean")
}
