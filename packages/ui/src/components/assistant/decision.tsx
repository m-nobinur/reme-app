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
  supersededBy,
  UNCONFIRMED,
} from "@workspace/ui/lib/tool-state"
import { cn, META } from "@workspace/ui/lib/utils"
import {
  createContext,
  type ReactNode,
  useContext,
  useId,
  useState,
} from "react"

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

/**
 * Marks a card's yes, by its approval id, as the owner's tap that saves a
 * grant (the chat sends it as `always`). Without a provider no card offers it.
 */
const AlwaysAllowContext = createContext<((approvalId: string) => void) | null>(
  null
)
export const AlwaysAllowProvider = AlwaysAllowContext.Provider

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
  /**
   * "beside": an Always allow button next to the yes, on a card whose kind
   * the owner may stop being asked for; "yes": the yes is itself that tap,
   * as on the card that offers it.
   */
  always?: "beside" | "yes" | undefined
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
  always,
}: DecisionProps<I, O>) {
  const id = useId()
  const allow = useContext(AlwaysAllowContext)
  const held = useAuiState((s) => isHeld(s.message.parts, props.toolCallId))
  const running = useAuiState((s) => s.message.status?.type === "running")
  const replaced = useAuiState((s) =>
    supersededBy(s.thread.messages, props.toolName, props.toolCallId)
  )
  // A card the owner moved past for a newer one of the same kind leaves no
  // line of its own; the newer one counts it.
  if (replaced === "later") return null
  const earlier = replaced ? (
    // A span, as it also sits inside the answered line's paragraph.
    <span className={cn(META, "block")}>
      {replaced === 1 ? "1 earlier card" : `${replaced} earlier cards`}:{" "}
      {cancelled.toLowerCase()}
    </span>
  ) : null

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
    const approvalId = props.approval?.id
    const approve = () => props.respondToApproval({ approved: true })
    const tap =
      always && allow && approvalId
        ? () => {
            allow(approvalId)
            void approve()
          }
        : null
    return (
      <TrayApproval
        also={
          !problem && always === "beside" && tap
            ? { label: "Always allow", onClick: tap }
            : undefined
        }
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
                onYes: always === "yes" && tap ? tap : approve,
              }
        }
      >
        {input ? <p>{detail(input)}</p> : null}
        {problem ? <Problem text={problem} /> : null}
        {earlier}
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
        {earlier}
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
        {earlier}
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
 * leaves alone, then the no, `also` and the yes. Without `yes` only the no
 * is offered. Outside a thread it is drawn where it stands.
 */
export function TrayApproval({
  name,
  title,
  yes,
  no,
  also,
  children,
}: {
  name: string
  title: string
  yes?: { label: string; onYes: () => void } | undefined
  no: { label: string; onNo: () => void }
  also?: { label: string; onClick: () => void } | undefined
  children: ReactNode
}) {
  const slot = useTraySlot()
  const [collapsed, setCollapsed] = useState(false)
  const frame = (
    <TrayFrame
      collapsed={collapsed}
      onCollapsedChange={setCollapsed}
      pick={also && { label: also.label, onPick: also.onClick }}
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
