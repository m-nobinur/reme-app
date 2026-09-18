import type { FactRecord, SiteFields } from "@workspace/contracts"

/** The `owner_stated` fact whose value is the fact keys the owner left off the site (ADR-033). */
export const HIDDEN_FACTS_KEY = "site.hidden_facts"

/**
 * The one place that says which facts a build must ask for. `ask` is the
 * required fact keys in the declaration order of `fields`, each once, without
 * the ones the owner left off the site; `hidden` is that set. `required` is
 * about asking and never about rendering, so nothing here says a field must
 * be filled.
 */
export function factsToAsk(
  fields: SiteFields,
  facts: readonly FactRecord[]
): { ask: string[]; hidden: string[] } {
  const value = facts.find((f) => f.key === HIDDEN_FACTS_KEY)?.value
  const hidden = Array.isArray(value)
    ? value.filter((key): key is string => typeof key === "string")
    : []
  const required = Object.values(fields).flatMap((field) =>
    field.kind === "fact" && field.required ? [field.fact_key] : []
  )
  return {
    ask: [...new Set(required)].filter((key) => !hidden.includes(key)),
    hidden,
  }
}
