import { currentFact, type OrgScopedDb } from "@workspace/db"

/**
 * The name the owner gave their assistant, for the messages Reme sends
 * unprompted, or null when none is set. Kept to one short line, since it
 * is the owner's text and goes into a model's instructions.
 */
export async function assistantName(db: OrgScopedDb): Promise<string | null> {
  const name = (
    (await currentFact(db, "assistant.name"))?.value as
      | { name?: unknown }
      | undefined
  )?.name
  const line = typeof name === "string" ? name.replace(/\s+/g, " ").trim() : ""
  return line ? line.slice(0, 40) : null
}
