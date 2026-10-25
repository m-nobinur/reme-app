import {
  type ToolCallMessagePartComponent,
  useAuiState,
} from "@assistant-ui/react"
import {
  CosChangeRequest,
  ONBOARDING_GOAL,
  RequestChangeOutput as RequestChangeResult,
} from "@workspace/contracts"
import { Decision, Done } from "@workspace/ui/components/assistant/decision"
import { decisionView, isRetried } from "@workspace/ui/lib/tool-state"

/**
 * A change the owner is asked to start: the first build at the end of
 * onboarding, what they typed in Act mode, or what the Chief of Staff
 * proposes. The change text is the immutable target and stays on screen in
 * every state, and "started" shows only once the server says a build exists.
 * Onboarding's own first build, once started, draws nothing: the owner never
 * asked for it in those words, and the panel shows it. Nor does a change the
 * owner's own words started with no card, nor a refusal the assistant
 * followed with another try.
 */

const RequestChange: ToolCallMessagePartComponent = (props) => {
  const view = decisionView(props, CosChangeRequest, RequestChangeResult)
  // A refusal waits for its turn to end: the assistant may still try again.
  const retried = useAuiState(
    (s) =>
      (s.message.status?.type === "running" && view.state === "refused") ||
      isRetried(s.message.parts, props.toolCallId)
  )
  // Started with no card to answer: the owner's message and the reply say it.
  const asked = (props as { approval?: unknown }).approval != null
  if (
    retried ||
    (view.state === "done" &&
      view.output?.outcome === "started" &&
      (!asked || view.input.text === ONBOARDING_GOAL))
  ) {
    return null
  }
  return (
    <Decision
      busy="Starting"
      cancelled="Not started."
      refused="The build could not be started."
      detail={() =>
        "This starts a build. Nothing goes live until you approve a version."
      }
      done={(output) => (
        <Done>
          {output?.outcome === "started" && output.build.lane === "quick"
            ? "Updating your preview."
            : "Started. Follow it in the panel."}
        </Done>
      )}
      props={props}
      slot="request-change"
      title={(input) => input.text}
      view={view}
      yes="Approve"
    />
  )
}
RequestChange.displayName = "RequestChange"

export { RequestChange }
