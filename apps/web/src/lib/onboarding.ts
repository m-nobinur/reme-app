import type { Conversation } from "@workspace/contracts"
import type { Workspace } from "./api/types"

/**
 * The onboarding conversation a new owner should land in, or null. New
 * means nothing built yet: no live version and no build under way. After
 * that, `/app` is the owner's own new chat again.
 */
export function onboardingFor(
  workspace: Workspace | null,
  conversations: Conversation[] | null
): string | null {
  if (!workspace || workspace.live !== null || workspace.builds.length > 0) {
    return null
  }
  return (
    conversations?.find(
      (each) => each.kind === "onboarding" && each.archived_at === null
    )?.id ?? null
  )
}
