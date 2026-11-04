/** A part of a skill: a reference file, viewed only when its "Read it when" line fits. */
export type Part = { name: string; when: string; body: string }

/** What a SKILL.md says, as the loader reads it. */
export type SkillFile = {
  name: string
  description: string
  expertise: string
  /** The lines the owner sees when the model's own line is missing or filtered. */
  status: readonly string[]
  /** The core: everything after the frontmatter. */
  body: string
  parts: readonly Part[]
}

/**
 * The frontmatter's subset of YAML these files use: `key: value`, or a
 * list of `- item` lines under a key.
 */
function frontmatter(lines: readonly string[]) {
  const out: Record<string, string | string[]> = {}
  let open: string | null = null
  for (const line of lines) {
    const item = /^\s+- (.+)$/.exec(line)
    const top = /^([a-z_]+):(?: (.+))?$/.exec(line)
    if (item && open) {
      out[open] = [
        ...((out[open] as string[] | undefined) ?? []),
        item[1] as string,
      ]
    } else if (top) {
      const [, key, value] = top as unknown as [string, string, string?]
      if (value === undefined) open = key
      else {
        out[key] = value
        open = null
      }
    } else if (line.trim()) {
      throw new Error(`skills: unreadable frontmatter line "${line}"`)
    }
  }
  return out
}

/** `## References` lines: `- part-name: Read it when ...`. */
const REFERENCE = /^- ([a-z][a-z0-9-]*): (Read it when .+)$/

/**
 * One SKILL.md and its reference files, by part name. Throws on a file that
 * breaks the format, so a bad skill fails at load and in the test, never in
 * a turn.
 */
export function readSkillFile(
  text: string,
  references: Readonly<Record<string, string>> = {}
): SkillFile {
  const [, head, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text) ?? []
  if (head === undefined || body === undefined) {
    throw new Error("skills: a SKILL.md opens with its frontmatter")
  }
  const meta = frontmatter(head.split("\n"))
  const { name, description, expertise, status } = meta
  if (
    typeof name !== "string" ||
    typeof description !== "string" ||
    typeof expertise !== "string" ||
    !Array.isArray(status)
  ) {
    throw new Error(
      `skills: ${String(name)} lacks name, description, expertise or status`
    )
  }
  const listed = (body.split("## References\n")[1] ?? "")
    .split("\n")
    .flatMap((line) => {
      const match = REFERENCE.exec(line)
      return match
        ? [{ name: match[1] as string, when: match[2] as string }]
        : []
    })
  const parts = listed.map(({ name: part, when }) => {
    const file = references[part]
    if (!file) throw new Error(`skills: ${name} lists ${part} with no file`)
    return { name: part, when, body: file.trim() }
  })
  const unlisted = Object.keys(references).filter(
    (part) => !listed.some((l) => l.name === part)
  )
  if (unlisted.length) {
    throw new Error(`skills: ${name} has unlisted parts ${unlisted.join(", ")}`)
  }
  return {
    name,
    description,
    expertise,
    status,
    body: body.trim(),
    parts,
  }
}
