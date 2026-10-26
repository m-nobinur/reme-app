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

/**
 * Whether setup is still open: the onboarding segment is there and not done.
 * It ends with a build started or a website skipped, unlike `onboardingFor`,
 * which waits for something built.
 */
export const settingUp = (workspace: Workspace | null) =>
  workspace?.activity?.journey.some(
    (segment) => segment.kind === "onboarding" && segment.state !== "done"
  ) ?? false
