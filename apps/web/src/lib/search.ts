import type { SearchSchemaInput } from "@tanstack/react-router"

/** The URL state every list view carries, before it grows its own filters. */
export type ListSearch = {
  /** Free-text filter. Absent rather than empty, so the URL stays clean. */
  q?: string
  /** One-based page number. */
  page: number
}

/**
 * `validateSearch` for the list views. Search params are user-editable input,
 * so this coerces rather than trusts, and falls back instead of throwing: a
 * hand-typed `?page=banana` should show page one, not an error screen.
 *
 * `SearchSchemaInput` marks the input as optional at the link level, so
 * `<Link to="/app/staff">` needs no search prop to satisfy the defaults.
 */
export function validateListSearch(
  search: Partial<ListSearch> & SearchSchemaInput
): ListSearch {
  const q = typeof search.q === "string" ? search.q.trim() : ""
  const page = Math.trunc(Number(search.page))
  const result: ListSearch = { page: page > 0 ? page : 1 }
  if (q) {
    result.q = q
  }
  return result
}
