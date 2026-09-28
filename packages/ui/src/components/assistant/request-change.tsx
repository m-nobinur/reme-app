import {
  type ToolCallMessagePartComponent,
  useAuiState,
} from "@assistant-ui/react"
import {
  CheckCircleIcon,
  ProhibitIcon,
  SealQuestionIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react"
import { Button } from "@workspace/ui/components/button"
import { useRevealWaiting } from "@workspace/ui/hooks/use-reveal-waiting"
import {
  heldText,
  isHeld,
  type RequestChangeView,
  requestChangeView,
} from "@workspace/ui/lib/tool-state"
import { cn } from "@workspace/ui/lib/utils"
import { useId } from "react"

/**
 * A change the owner is asked to start: the first build at the end of
 * onboarding, or what they typed in Act mode. The change text is the
 * immutable target and stays on screen in every state. It is never
 * optimistic: after a tap the buttons wait for the server, and "started"
 * shows only once the server says a build exists.
 */

/** The build's short ids, as support and the panel match them. */
function builtAs(view: Extract<RequestChangeView, { state: "started" }>) {
  const { revision, assignment_id } = view.output.build
  return revision
    ? `Version ${revision.version}, ID ${revision.revision_id.slice(0, 8)}`
    : `Build ${assignment_id.slice(0, 8)}`
}

/** What became of the change, once it is no longer the owner's to decide. */
function Outcome({ view }: { view: RequestChangeView }) {
  switch (view.state) {
    case "started":
      return (
        <>
          <p className="flex items-center gap-2 text-sm">
            <CheckCircleIcon
              aria-hidden
              className="size-4 shrink-0 text-primary"
            />
            Started. Follow it under Working on.
          </p>
          <p className="text-[0.8125rem] text-muted-foreground">
            {builtAs(view)}
          </p>
        </>
      )
    case "denied":
      return (
        <p className="flex items-center gap-2 text-muted-foreground text-sm">
          <ProhibitIcon aria-hidden className="size-4 shrink-0" />
          You said not now.
        </p>
      )
    case "cancelled":
      return (
        <p className="text-muted-foreground text-sm">
          Not started. You sent a message instead.
        </p>
      )
    case "drafting":
      // The model is still writing the change: nothing to approve yet.
      return (
        <p
          className="shimmer text-muted-foreground text-sm motion-reduce:animate-none"
          role="status"
        >
          Writing the change
        </p>
      )
    case "refused":
    case "error":
      return (
        <p className="flex items-start gap-2 text-destructive text-sm">
          <WarningCircleIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          {view.message}
        </p>
      )
    default:
      return null
  }
}

const RequestChange: ToolCallMessagePartComponent = (props) => {
  const view = requestChangeView(props)
  const id = useId()
  const deciding =
    view.state === "approval-requested" || view.state === "responding"
  useRevealWaiting(view.state === "approval-requested")
  // Another card in the same step still waits on the owner, so this answer
  // has not been sent: nothing is starting yet.
  const held = useAuiState((s) => isHeld(s.message.parts, props.toolCallId))

  return (
    <section
      aria-labelledby={`${id}-text`}
      className={cn(
        "my-3 flex max-w-md flex-col gap-2",
        deciding && "rounded-2xl border border-border bg-card p-4"
      )}
      data-slot="request-change"
    >
      {deciding ? (
        <p className="flex items-center gap-2 text-muted-foreground text-sm">
          <SealQuestionIcon aria-hidden className="size-4 text-primary" />
          Needs your yes
        </p>
      ) : null}
      <h3 className="break-words font-medium" id={`${id}-text`}>
        {view.text || "A change"}
      </h3>
      {deciding ? (
        <>
          <p className="text-[0.8125rem] text-muted-foreground">
            This starts a build. Nothing goes live until you approve a version.
          </p>
          {held && view.state === "responding" ? (
            // Answered while another card in the step waits: the answer is
            // recorded and nothing is running, so no buttons, only the answer.
            <p className="text-[0.8125rem] text-muted-foreground" role="status">
              {heldText(view.approved)}
            </p>
          ) : (
            <div aria-busy={view.state === "responding"} className="flex gap-2">
              <Button
                disabled={view.state === "responding"}
                onClick={() => props.respondToApproval({ approved: true })}
                size="sm"
                type="button"
              >
                {view.state === "responding" && view.approved
                  ? "Starting"
                  : "Approve"}
              </Button>
              <Button
                disabled={view.state === "responding"}
                onClick={() => props.respondToApproval({ approved: false })}
                size="sm"
                type="button"
                variant="outline"
              >
                Not now
              </Button>
            </div>
          )}
        </>
      ) : (
        <Outcome view={view} />
      )}
    </section>
  )
}
RequestChange.displayName = "RequestChange"

export { RequestChange }
