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

import type { ComponentManifest } from "@workspace/contracts"

/** 14,000 characters is about 3,500 tokens at the ratio measured on the starter, in the cached segment. The starter with its fonts, palettes, directions and section heads needed about 10,200 (2026-10-14); the 99 ICONS keys the Developer may name, the favicon set and the motifs bring it to 13,487 (2026-10-15). `seed.test.ts` fails if the seed's own map is ever cut. */
export const REPO_MAP_MAX_CHARS = 14_000

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

/** A component's manifest, beside it under its own folder. */
const MANIFEST = /^src\/components\/[^/]+\/manifest\.yaml$/

/**
 * The map, one line a file, cut at `REPO_MAP_MAX_CHARS` with a notice naming
 * what was left out. The component manifests share one line where the first
 * would sit: their paths follow from the components the digest lists, and a
 * line each said only their size.
 */
export function repoMap(files: Record<string, string>): string {
  const paths = Object.keys(files).sort()
  const manifests = paths.filter((p) => MANIFEST.test(p))
  // Each line with the files it stands for, so a cut map names what it left.
  const entries = paths.flatMap((p) => {
    if (!MANIFEST.test(p))
      return [{ line: describeFile(p, files[p] as string), paths: [p] }]
    if (p !== manifests[0]) return []
    return [
      {
        line: `src/components/<Name>/manifest.yaml (${manifests.length} files): one beside each component, with its constraints and examples`,
        paths: manifests,
      },
    ]
  })
  const whole = entries.map((e) => e.line).join("\n")
  if (whole.length <= REPO_MAP_MAX_CHARS) return whole

  const kept: string[] = []
  let size = 0
  for (const { line } of entries) {
    const next = size + (kept.length > 0 ? 1 : 0) + line.length
    if (next > REPO_MAP_MAX_CHARS - NOTICE_CHARS) break
    kept.push(line)
    size = next
  }
  const left = entries.slice(kept.length).flatMap((e) => e.paths)
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

/** 6,000 characters is about 1,760 tokens at the measured 3.4 characters a token. */
const DIGEST_MAX_CHARS = 6_000

/**
 * The starter's components as the Developer is shown them (architect ruling
 * on N5, §11.2): one line each, name, path, props with type and whether
 * required, and what the component must never be used for. The full
 * `manifest.yaml` stays readable with `read`. Past the cap it throws: a cut
 * digest would hide a forbidden use, which is worse than a failed build of
 * the bundle. A pure function, so a restored site can feed it its own
 * manifests.
 */
export function manifestDigest(
  manifests: readonly ComponentManifest[]
): string {
  const lines = [...manifests]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((m) => {
      const props = m.props
        .map((p) => `${p.name}${p.required ? "" : "?"}: ${p.type}`)
        .join(", ")
      const bits = [props ? `props ${props}` : "no props"]
      if (m.forbidden.length > 0) bits.push(`never: ${m.forbidden.join("; ")}`)
      return `${m.component} (${m.path}): ${bits.join("; ")}`
    })
  const digest = lines.join("\n")
  if (digest.length > DIGEST_MAX_CHARS) {
    throw new Error(
      `the manifest digest is ${digest.length} characters, past the ${DIGEST_MAX_CHARS} characters it may take; trim the manifests or revisit the digest ruling`
    )
  }
  return digest
}
