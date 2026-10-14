import type { ToolCallMessagePartComponent } from "@assistant-ui/react"
import {
  OwnerChangeRequest,
  type RequestChangeOutput,
  RequestChangeOutput as RequestChangeResult,
} from "@workspace/contracts"
import { Decision, Done } from "@workspace/ui/components/assistant/decision"
import { decisionView } from "@workspace/ui/lib/tool-state"

/**
 * A change the owner is asked to start: the first build at the end of
 * onboarding, what they typed in Act mode, or what the Chief of Staff
 * proposes. The change text is the immutable target and stays on screen in
 * every state, and "started" shows only once the server says a build exists.
 */

type Started = Extract<RequestChangeOutput, { outcome: "started" }>

/** The build's short ids, as support and the panel match them. */
function builtAs({ build }: Started) {
  return build.revision
    ? `Version ${build.revision.version}, ID ${build.revision.revision_id.slice(0, 8)}`
    : `Build ${build.assignment_id.slice(0, 8)}`
}

const RequestChange: ToolCallMessagePartComponent = (props) => (
  <Decision
    busy="Starting"
    cancelled="Not started. You sent a message instead."
    refused="The build could not be started."
    detail={() =>
      "This starts a build. Nothing goes live until you approve a version."
    }
    done={(output) => (
      <>
        <Done>
          {output?.outcome === "started" && output.build.lane === "quick"
            ? "Updating your preview."
            : "Started. Follow it under Working on."}
        </Done>
        {output?.outcome === "started" ? (
          <p className="text-[0.8125rem] text-muted-foreground">
            {builtAs(output)}
          </p>
        ) : null}
      </>
    )}
    props={props}
    slot="request-change"
    title={(input) => input.text}
    view={decisionView(props, OwnerChangeRequest, RequestChangeResult)}
    yes="Approve"
  />
)
RequestChange.displayName = "RequestChange"

export { RequestChange }
