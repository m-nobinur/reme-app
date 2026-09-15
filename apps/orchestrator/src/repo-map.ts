/**
 * The map of the site the Developer is shown (§8.2 "Repo map + symbol
 * index", architect ruling on N4): every file in path order with its size,
 * what it exports (and an exported object's fields), the props it takes, the
 * names it imports, and which fields of those names it reads. Path order
 * keeps the prompt cache stable; at a dozen files ranking changes nothing.
 *
 * ponytail: regular expressions over TypeScript and Astro frontmatter, not a
 * parser. When a site's map passes the cap, tree-sitter tags ranked by
 * references (Aider's repomap) is the upgrade.
 */

/** 4,000 characters is about 1,000 tokens at the ratio measured on the starter. */
export const REPO_MAP_MAX_CHARS = 4_000

/** Room kept for the notice that says what a cut map left out. */
const NOTICE_CHARS = 600

const bytes = (text: string) => new TextEncoder().encode(text).length

function describeFile(path: string, text: string): string {
  const bits: string[] = []
  const exported = [
    ...text.matchAll(
      /export\s+(?:default\s+)?(?:const|let|function|class|interface|type)\s+(\w+)/g
    ),
  ].map((m) => {
    const name = m[1] as string
    const body = text.match(
      new RegExp(`export const ${name}\\s*=\\s*\\{\\n([\\s\\S]*?)\\n\\}`)
    )?.[1]
    const fields = body
      ? [...body.matchAll(/^ {2}(\w+):/gm)].map((f) => f[1])
      : []
    return fields.length > 0 ? `${name} {${fields.join(", ")}}` : name
  })
  if (exported.length > 0) bits.push(`exports ${exported.join(", ")}`)

  const props = text.match(/interface Props\s*\{([^}]*)\}/)?.[1]
  if (props) bits.push(`props {${props.trim().replace(/\s+/g, " ")}}`)

  const imported = [
    ...text.matchAll(
      /import\s+(?:\{\s*)?(\w+)(?:\s*\})?\s+from\s+["'][^"']+["']/g
    ),
  ].map((m) => m[1] as string)
  if (imported.length > 0) bits.push(`uses ${imported.join(", ")}`)

  // Import lines name files (`../layouts/Base.astro`), not fields read.
  const body = text.replace(/^import .*$/gm, "")
  const reads = [
    ...new Set(
      imported.flatMap((name) =>
        [...body.matchAll(new RegExp(`\\b${name}\\.(\\w+)`, "g"))].map(
          (m) => `${name}.${m[1]}`
        )
      )
    ),
  ]
  if (reads.length > 0) bits.push(`reads ${reads.join(", ")}`)

  const head = `${path} (${bytes(text)} B)`
  return bits.length > 0 ? `${head}: ${bits.join("; ")}` : head
}

/** The map, one line a file, cut at `REPO_MAP_MAX_CHARS` with a notice naming what was left out. */
export function repoMap(files: Record<string, string>): string {
  const paths = Object.keys(files).sort()
  const lines = paths.map((p) => describeFile(p, files[p] as string))
  const whole = lines.join("\n")
  if (whole.length <= REPO_MAP_MAX_CHARS) return whole

  const kept: string[] = []
  let size = 0
  for (const line of lines) {
    const next = size + (kept.length > 0 ? 1 : 0) + line.length
    if (next > REPO_MAP_MAX_CHARS - NOTICE_CHARS) break
    kept.push(line)
    size = next
  }
  const left = paths.slice(kept.length)
  let notice = `[Map cut at ${REPO_MAP_MAX_CHARS} characters: ${left.length} files not listed: `
  let named = 0
  for (const path of left) {
    if (notice.length + path.length + 40 > NOTICE_CHARS) break
    notice += `${named > 0 ? ", " : ""}${path}`
    named++
  }
  notice += named < left.length ? `, and ${left.length - named} more]` : "]"
  return [...kept, notice].join("\n")
}
