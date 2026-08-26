import type { SearchSchemaInput } from "@tanstack/react-router"

/** The URL state every list view carries, before it grows its own filters. */
export type ListSearch = {
  /** Free-text filter. Absent rather than empty, so the URL stays clean. */
  q?: string
  /** One-based page number. */
  page: number
}

/**
 * Guards, not product decisions. A page number reaches an `OFFSET` and a query
 * reaches a `LIKE`, so both are bounded here rather than wherever they land.
 * Raise them when a list has the rows to justify it.
 */
const MAX_PAGE = 10_000
const MAX_QUERY = 200

/** A repeated `?q=a&q=b` arrives as an array. First wins, so the URL stays readable. */
function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value
}

function toPage(value: unknown): number {
  const raw = first(value)
  // From a URL every value is a string, and only digits are a page. `Number`
  // alone would accept `0x10` as 16 and `1e999` as Infinity.
  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+$/.test(raw.trim())
        ? Number(raw.trim())
        : Number.NaN
  if (!Number.isFinite(parsed)) {
    return 1
  }
  const page = Math.trunc(parsed)
  if (page < 1) {
    return 1
  }
  return page > MAX_PAGE ? MAX_PAGE : page
}

function toQuery(value: unknown): string {
  const raw = first(value)
  return typeof raw === "string" ? raw.trim().slice(0, MAX_QUERY) : ""
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
  const q = toQuery((search as Record<string, unknown>).q)
  const result: ListSearch = {
    page: toPage((search as Record<string, unknown>).page),
  }
  if (q) {
    result.q = q
  }
  return result
}
