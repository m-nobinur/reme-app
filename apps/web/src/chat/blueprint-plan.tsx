import { BlueprintReviewOutput } from "@workspace/contracts"
import { BlueprintCard } from "@workspace/ui/components/assistant/blueprint-card"
import { CHANGE_PREFIX } from "@workspace/ui/lib/blueprint"
import { type ReactNode, useState } from "react"
import { decideBlueprint } from "@/lib/api/server"
import type { Workspace } from "@/lib/api/types"
import type { useLiveWorkspace } from "@/lib/workspace"

const FAILED = "That did not go through. Try again."

/**
 * The Blueprint card in chat, drawn from the polled workspace the way the
 * ready card is (ADR-038): never a stored message, so it shows in whichever
 * conversation is open, during onboarding and for a creative change alike.
 */

/** The newest build whose plan waits on the owner, or null. */
export function awaitingPlan(workspace: Workspace | null) {
  const build = workspace?.builds.find((b) => b.blueprint?.awaiting)
  return build?.blueprint
    ? { assignmentId: build.assignment_id, ...build.blueprint }
    : null
}

/**
 * The owner's note when a typed message finishes "Change something": the
 * words after the prefix the card left in the composer. Null for any other
 * message, which goes to the assistant as itself.
 */
export function planNote(text: string): string | null {
  const typed = text.trim()
  const prefix = CHANGE_PREFIX.trim()
  if (!typed.startsWith(prefix)) return null
  const note = typed.slice(prefix.length).trim()
  return BlueprintReviewOutput.safeParse({ decision: "change", note }).success
    ? note
    : null
}

/**
 * The card and the change a typed note makes. "Build it" decides from the
 * card; "Change something" hands the owner to the composer, and the runtime
 * sends the finished message here through `change` instead of to the chat.
 */
export function usePlanCard(live: ReturnType<typeof useLiveWorkspace>): {
  card: ReactNode
  change: ((note: string) => Promise<boolean>) | null
} {
  const plan = awaitingPlan(live.workspace)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A change sent from here, until the next round's plan replaces it.
  const [sent, setSent] = useState<{ id: string; round: number } | null>(null)

  const decide = async (decision: BlueprintReviewOutput) => {
    if (!plan) return false
    setPending(true)
    setError(null)
    try {
      const outcome = await decideBlueprint({
        data: {
          assignmentId: plan.assignmentId,
          decision,
          // The same decision on the same round again is a retry.
          key: `blueprint:${plan.assignmentId}:${plan.round}:${decision.decision}`,
        },
      })
      if (!outcome.done) {
        setError(outcome.reason)
        return false
      }
      if (decision.decision === "change") {
        setSent({ id: plan.assignmentId, round: plan.round })
      }
      await live.refresh()
      return true
    } catch {
      setError(FAILED)
      return false
    } finally {
      setPending(false)
    }
  }

  const replanning =
    sent !== null &&
    !plan &&
    live.workspace?.builds.some(
      (b) => b.assignment_id === sent.id && b.state === "planning"
    )
  const card = plan ? (
    <div aria-busy={pending}>
      <BlueprintCard
        blueprint={plan.plan}
        key={`${plan.assignmentId}:${plan.round}`}
        onBuild={() => void decide({ decision: "build" })}
        previous={plan.previous}
      />
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  ) : replanning ? (
    <p className="my-3 text-muted-foreground text-sm" role="status">
      Changing the plan with your note.
    </p>
  ) : null
  return {
    card,
    change:
      plan && !pending ? (note) => decide({ decision: "change", note }) : null,
  }
}
