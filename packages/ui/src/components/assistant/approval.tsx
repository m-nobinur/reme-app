import {
  type ToolCallMessagePartComponent,
  type ToolCallMessagePartProps,
  useAuiState,
} from "@assistant-ui/react"
import { TrayApproval } from "@workspace/ui/components/assistant/decision"
import { ToolFallback } from "@workspace/ui/components/assistant/tool-fallback"
import { StateIcon } from "@workspace/ui/components/status-line"
import { toolLine } from "@workspace/ui/lib/activity-copy"
import { heldText, isHeld, isRepeat } from "@workspace/ui/lib/tool-state"

/**
 * The approval half of the owner attention contract, in the transcript.
 *
 * An ApprovalRequest is bound to an immutable target, so the card names every
 * field of the call the runtime is holding, and answering it is one tap. It is
 * never optimistic: the transcript shows the decision only after the runtime
 * has recorded it, which is why the buttons read their state from the part
 * rather than from a local flag.
 *
 * This is the thread's fallback for a tool call no toolkit entry renders
 * (`toolkit.tsx` registers every card by its tool name). Any such call the
 * runtime is waiting on a human for is an approval, whatever it is called,
 * and anything else falls through to `ToolFallback`.
 */

/** A tool call's input as the rows a person reads before deciding. */
function targetRows(input: unknown): [string, string][] {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return []
  }
  return Object.entries(input as Record<string, unknown>).map(
    ([key, value]) => [
      key.replace(/[_-]/g, " "),
      typeof value === "string" ? value : JSON.stringify(value),
    ]
  )
}

function ApprovalTarget({ input }: { input: unknown }) {
  const rows = targetRows(input)
  if (rows.length === 0) return null

  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {rows.map(([label, value]) => (
        <div className="contents" key={label}>
          <dt className="text-muted-foreground first-letter:uppercase">
            {label}
          </dt>
          <dd className="min-w-0 break-words font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** The card the owner answers, in the tray. Two buttons, no third state, no confirm step. */
function ApprovalRequest({
  toolName,
  input,
  reason,
  respondToApproval,
}: {
  toolName: string
  input: unknown
  reason: string | undefined
  respondToApproval: ToolCallMessagePartProps["respondToApproval"]
}) {
  return (
    <TrayApproval
      name="approval-request"
      no={{
        label: "Not now",
        onNo: () => respondToApproval({ approved: false }),
      }}
      title={toolLine(toolName, "waiting")}
      yes={{
        label: "Approve",
        onYes: () => respondToApproval({ approved: true }),
      }}
    >
      {reason ? <p className="max-w-prose">{reason}</p> : null}
      <ApprovalTarget input={input} />
    </TrayApproval>
  )
}

/** What the transcript keeps once the owner has answered. */
function ApprovalDecision({ approved }: { approved: boolean }) {
  return (
    <p
      className="flex items-center gap-2 px-1 py-1.5 text-muted-foreground text-sm"
      data-slot="approval-decision"
    >
      <StateIcon state={approved ? "done" : "stopped"} />
      {approved ? "You approved this." : "You said not now."}
    </p>
  )
}

const Approval: ToolCallMessagePartComponent = (props) => {
  const { approval, respondToApproval, toolName } = props
  const held = useAuiState((s) => isHeld(s.message.parts, props.toolCallId))
  if (isRepeat(props)) return null

  // Only a real approval gate takes the card. A tool paused on an interrupt has
  // no approval to respond to, and `ToolFallback` already offers it a way out.
  if (approval != null && approval.approved === undefined) {
    return (
      <ApprovalRequest
        input={props.args}
        reason={approval.reason}
        respondToApproval={respondToApproval}
        toolName={toolName}
      />
    )
  }

  // Answered, with another card in the step still open: not sent yet.
  if (held && approval?.approved !== undefined) {
    return (
      <p
        className="px-1 py-1.5 text-muted-foreground text-sm"
        data-slot="approval-held"
        role="status"
      >
        {heldText(approval.approved)}
      </p>
    )
  }

  if (approval?.approved !== undefined) {
    return (
      <>
        <ApprovalDecision approved={approval.approved} />
        <ToolFallback {...props} />
      </>
    )
  }

  return <ToolFallback {...props} />
}
Approval.displayName = "Approval"

export { Approval }
