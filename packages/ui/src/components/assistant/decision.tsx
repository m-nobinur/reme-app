import { type ToolCallMessagePartProps, useAuiState } from "@assistant-ui/react"
import {
  CheckCircleIcon,
  ProhibitIcon,
  SealQuestionIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react"
import { Button } from "@workspace/ui/components/button"
import { useRevealWaiting } from "@workspace/ui/hooks/use-reveal-waiting"
import { refusalText } from "@workspace/ui/lib/refusal"
import {
  BROKEN,
  type DecisionView,
  heldText,
  isHeld,
  NOT_DONE,
  UNCONFIRMED,
} from "@workspace/ui/lib/tool-state"
import { cn } from "@workspace/ui/lib/utils"
import { type ReactNode, useId } from "react"

/**
 * The card every tool that waits for the owner's yes is drawn with, so an
 * approval fix lands once. The target stays on screen in every state. It is
 * never optimistic: after a tap the buttons wait for the server, and a held
 * answer says it has not been sent while another card in its step waits.
 * No yes is offered on a target the owner cannot read or check, and a call
 * the stream left unfinished never shimmers on after it ends.
 */

const META = "text-[0.8125rem] text-muted-foreground"

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
  busy,
  cancelled,
  refused,
  done,
  blocked,
}: DecisionProps<I, O>) {
  const id = useId()
  const held = useAuiState((s) => isHeld(s.message.parts, props.toolCallId))
  const running = useAuiState((s) => s.message.status?.type === "running")
  useRevealWaiting(view.state === "asking")

  if (view.state === "drafting") {
    return (
      <p
        className={cn(
          "px-1 py-1.5 text-muted-foreground text-sm",
          running && "shimmer motion-reduce:animate-none"
        )}
        data-slot={slot}
        role={running ? "status" : undefined}
      >
        {running ? "Writing this out" : UNFINISHED}
      </p>
    )
  }

  const input = "input" in view ? view.input : null
  const withheld =
    view.state === "asking" && input && blocked ? blocked(input) : null
  const deciding = view.state === "asking" || view.state === "responding"
  const waiting = deciding || (view.state === "broken" && view.waiting)

  return (
    <section
      aria-labelledby={`${id}-title`}
      className={cn(
        "my-3 flex max-w-md flex-col gap-2",
        waiting && "rounded-2xl border border-border bg-card p-4"
      )}
      data-slot={slot}
    >
      {deciding ? (
        <p className="flex items-center gap-2 text-muted-foreground text-sm">
          <SealQuestionIcon aria-hidden className="size-4 text-primary" />
          Needs your yes
        </p>
      ) : null}
      <h3 className="break-words font-medium" id={`${id}-title`}>
        {input ? title(input) : "Something the assistant asked for"}
      </h3>
      {input && deciding ? <p className={META}>{detail(input)}</p> : null}
      {view.state === "broken" ? (
        <Problem text={view.waiting ? CANNOT_APPROVE : BROKEN} />
      ) : null}
      {withheld ? <Problem text={withheld} /> : null}
      {held && view.state === "responding" ? (
        // Answered while another card in the step waits: the answer is
        // recorded and nothing is running, so no buttons, only the answer.
        <p className={META} role="status">
          {heldText(view.approved)}
        </p>
      ) : waiting ? (
        <div aria-busy={view.state === "responding"} className="flex gap-2">
          {view.state === "broken" || withheld ? null : (
            <Button
              disabled={view.state === "responding"}
              onClick={() => props.respondToApproval({ approved: true })}
              size="sm"
              type="button"
            >
              {view.state === "responding" && view.approved ? busy : yes}
            </Button>
          )}
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
      ) : view.state === "done" ? (
        done(view.output)
      ) : view.state === "refused" ? (
        <Problem text={refusalText(view.code, refused)} />
      ) : view.state === "denied" ? (
        <p className="flex items-center gap-2 text-muted-foreground text-sm">
          <ProhibitIcon aria-hidden className="size-4 shrink-0" />
          You said not now.
        </p>
      ) : view.state === "cancelled" ? (
        <p className="text-muted-foreground text-sm">{cancelled}</p>
      ) : view.state === "unconfirmed" ? (
        <Problem text={UNCONFIRMED} />
      ) : view.state === "failed" ? (
        <Problem text={NOT_DONE} />
      ) : null}
    </section>
  )
}

export function Problem({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-2 text-destructive text-sm">
      <WarningCircleIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
      {text}
    </p>
  )
}

export function Done({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm">
      <CheckCircleIcon aria-hidden className="size-4 shrink-0 text-primary" />
      {children}
    </p>
  )
}
