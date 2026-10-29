import { type ToolCallMessagePartProps, useAuiState } from "@assistant-ui/react"
import {
  Docked,
  TrayFrame,
  useTraySlot,
} from "@workspace/ui/components/assistant/question-tray"
import {
  DoneIcon,
  StateIcon,
  StatusLine,
  ToolStatus,
} from "@workspace/ui/components/status-line"
import { refusalText } from "@workspace/ui/lib/refusal"
import {
  BROKEN,
  type DecisionView,
  EXPIRED,
  heldText,
  isHeld,
  NOT_DONE,
  UNCONFIRMED,
} from "@workspace/ui/lib/tool-state"
import { cn } from "@workspace/ui/lib/utils"
import { type ReactNode, useId, useState } from "react"

/**
 * The card every tool that waits for the owner's yes is drawn with, so an
 * approval fix lands once. While it waits it sits in the question tray
 * (`TrayApproval`); answered, it is one line in the thread, and the target
 * stays named in every state. It is never optimistic: after a tap the line
 * says it is on its way until the server answers, and a held answer says it
 * has not been sent while another card in its step waits.
 * No yes is offered on a target the owner cannot read or check, and a call
 * the stream left unfinished never shimmers on after it ends.
 */

const CANNOT_APPROVE =
  "This did not come through whole, so it cannot be approved. Say not now to carry on."
const UNFINISHED = "This was not finished. Ask again if you still want it."

type DecisionProps<I, O> = {
  slot: string
  view: DecisionView<I, O>
  props: ToolCallMessagePartProps
  title: (input: I) => string
  /** What a yes does, shown while the owner decides. */
  detail: (input: I) => ReactNode
  yes: string
  /** The cancel button's label. */
  no?: string
  busy: string
  /** What a cancel by a typed message left undone. */
  cancelled: string
  /** What a refusal says when its code has no line of its own. */
  refused: string
  /** A done call, with its output, or null when the output could not be read. */
  done: (output: O | null) => ReactNode
  /** Why no yes can be offered for this input, if one cannot. */
  blocked?: ((input: I) => string | null) | undefined
}

export function Decision<I, O>({
  slot,
  view,
  props,
  title,
  detail,
  yes,
  no = "Not now",
  busy,
  cancelled,
  refused,
  done,
  blocked,
}: DecisionProps<I, O>) {
  const id = useId()
  const held = useAuiState((s) => isHeld(s.message.parts, props.toolCallId))
  const running = useAuiState((s) => s.message.status?.type === "running")

  if (view.state === "drafting") {
    return running ? (
      <ToolStatus
        className="flex px-1 py-1.5 text-sm"
        data-slot={slot}
        state="working"
        tool={props.toolName}
      />
    ) : (
      <StatusLine
        className="flex px-1 py-1.5 text-sm"
        data-slot={slot}
        label={UNFINISHED}
        state="stopped"
      />
    )
  }

  const input = "input" in view ? view.input : null
  const heading = input ? title(input) : "Something the assistant asked for"

  if (view.state === "asking" || (view.state === "broken" && view.waiting)) {
    const withheld = input && blocked ? blocked(input) : null
    const problem = view.state === "broken" ? CANNOT_APPROVE : withheld
    return (
      <TrayApproval
        name={slot}
        no={{
          label: no,
          onNo: () => props.respondToApproval({ approved: false }),
        }}
        title={heading}
        yes={
          problem
            ? undefined
            : {
                label: yes,
                onYes: () => props.respondToApproval({ approved: true }),
              }
        }
      >
        {input ? <p>{detail(input)}</p> : null}
        {problem ? <Problem text={problem} /> : null}
      </TrayApproval>
    )
  }

  if (view.state === "done") {
    return (
      <section
        aria-labelledby={`${id}-title`}
        className="my-3 flex max-w-md flex-col gap-2"
        data-slot={slot}
      >
        <h3 className="break-words font-medium" id={`${id}-title`}>
          {heading}
        </h3>
        {done(view.output)}
      </section>
    )
  }

  // Answered: one line in the thread, what was asked and how it ended.
  const sending = view.state === "responding" && view.approved && !held
  const [line, failed] = endLine(view, held, busy, cancelled, refused)
  return (
    <p
      className={cn(
        "my-3 flex max-w-md items-start gap-2 text-sm",
        failed ? "text-destructive" : "text-muted-foreground"
      )}
      data-slot={slot}
    >
      <StateIcon
        className="mt-0.5"
        state={
          sending
            ? "working"
            : failed
              ? "failed"
              : view.state === "responding" && held
                ? "waiting"
                : "stopped"
        }
      />
      <span className="min-w-0 break-words">
        <span className="font-medium text-foreground">{heading}</span>{" "}
        <span
          aria-busy={sending || undefined}
          role={view.state === "responding" ? "status" : undefined}
        >
          {line}
        </span>
      </span>
    </p>
  )
}

/** How an answered call ended, and whether that is a failure. */
function endLine<I, O>(
  view: DecisionView<I, O>,
  held: boolean,
  busy: string,
  cancelled: string,
  refused: string
): [string, boolean] {
  switch (view.state) {
    case "responding":
      return [
        held
          ? heldText(view.approved)
          : view.approved
            ? `${busy}…`
            : "You said not now.",
        false,
      ]
    case "denied":
      return ["You said not now.", false]
    case "cancelled":
      return [cancelled, false]
    case "refused":
      return [refusalText(view.code, refused), true]
    case "unconfirmed":
      return [UNCONFIRMED, true]
    case "failed":
      return [NOT_DONE, true]
    case "expired":
      return [EXPIRED, true]
    default:
      return [BROKEN, true]
  }
}

/**
 * An approval in the question tray: its title, what a yes does and what it
 * leaves alone, then the no and the yes. Without `yes` only the no is
 * offered. Outside a thread it is drawn where it stands.
 */
export function TrayApproval({
  name,
  title,
  yes,
  no,
  children,
}: {
  name: string
  title: string
  yes?: { label: string; onYes: () => void } | undefined
  no: { label: string; onNo: () => void }
  children: ReactNode
}) {
  const slot = useTraySlot()
  const [collapsed, setCollapsed] = useState(false)
  const frame = (
    <TrayFrame
      collapsed={collapsed}
      onCollapsedChange={setCollapsed}
      question={title}
      skip={{ label: no.label, onSkip: no.onNo }}
      submit={yes ? { label: yes.label, onSubmit: yes.onYes } : undefined}
    >
      <div className="flex flex-col gap-2 px-2 py-1 text-sm">{children}</div>
    </TrayFrame>
  )
  return slot ? <Docked name={name}>{frame}</Docked> : frame
}

export function Problem({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-2 text-destructive text-sm">
      <StateIcon className="mt-0.5" state="failed" />
      {text}
    </p>
  )
}

export function Done({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm">
      <DoneIcon />
      {children}
    </p>
  )
}
