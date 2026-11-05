import { useAui, useAuiState } from "@assistant-ui/react"
import { Choices, OfferChoicesInput } from "@workspace/contracts"
import {
  ReplyPill,
  ReplyPills,
} from "@workspace/ui/components/assistant/reply-pill"
import { useEffect, useMemo, useState } from "react"

/** How long the row fades once its message is no longer the newest. */
const FADE_MS = 200

/**
 * The quick replies a message's parts offer: a posted notice's choices, or
 * the CoS's offer_choices call. Null when it offers none.
 */
export function choicesOf(parts: readonly object[] | undefined) {
  for (const part of parts ?? []) {
    const p = part as {
      type?: string
      name?: string
      data?: unknown
      toolName?: string
      args?: unknown
    }
    const read =
      p.type === "data" && p.name === "choices"
        ? Choices.safeParse(p.data).data
        : p.type === "tool-call" && p.toolName === "offer_choices"
          ? OfferChoicesInput.safeParse(p.args).data?.choices
          : undefined
    if (read) return read
  }
  return null
}

/**
 * The newest message's quick replies, above the composer. They fade once the
 * owner sends anything or any newer message lands, so after a reload they
 * show only while their message is still the last. With two or more, the
 * first is the recommendation. A tap sends its message as the owner's;
 * typing is the other answer.
 */
export function DecisionPills() {
  const aui = useAui()
  const last = useAuiState((s) =>
    s.thread.isRunning ? null : (s.thread.messages.at(-1) ?? null)
  )
  const offered = useMemo(
    () => (last?.role === "assistant" ? choicesOf(last.parts) : null),
    [last]
  )
  const [held, setHeld] = useState(offered)
  if (offered && offered !== held) setHeld(offered)
  useEffect(() => {
    if (offered || !held) return
    const timer = setTimeout(() => setHeld(null), FADE_MS)
    return () => clearTimeout(timer)
  }, [offered, held])
  if (!held) return null
  return (
    <ReplyPills composer gone={!offered} label="Quick replies">
      {held.map((choice, index) => {
        const recommended = index === 0 && held.length > 1
        return (
          <ReplyPill
            className={
              recommended ? "border-foreground/40 text-foreground" : undefined
            }
            data-recommended={recommended || undefined}
            key={choice.label}
            onClick={() => aui.thread().append(choice.send)}
          >
            {choice.label}
            {recommended ? (
              <span className="sr-only">, recommended</span>
            ) : null}
          </ReplyPill>
        )
      })}
    </ReplyPills>
  )
}
