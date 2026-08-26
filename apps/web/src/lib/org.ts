import type { OrgOption } from "@workspace/ui/components/org-switcher"

/**
 * The organisations the signed-in owner can switch between.
 *
 * There is no organisation table, no API and no session yet, so this resolves
 * to nothing and the switcher renders its empty state. It stays a single
 * function called from the layout loader so the real read replaces it here,
 * without the layout or the switcher changing.
 */
export async function listOwnerOrgs(): Promise<OrgOption[]> {
  return []
}
