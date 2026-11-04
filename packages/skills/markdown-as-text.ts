import { readFileSync } from "node:fs"

/**
 * Loads a `.md` import as its text, as wrangler's `Text` rule does in the
 * api Worker, for Vitest, which would otherwise refuse the file.
 */
export const markdownAsText = {
  name: "markdown-as-text",
  enforce: "pre" as const,
  load(id: string) {
    return id.endsWith(".md")
      ? `export default ${JSON.stringify(readFileSync(id, "utf8"))}`
      : null
  },
}
