import { useAui, useAuiState } from "@assistant-ui/react"
import { DICTATION_TIDY_MS, needsTidy } from "@workspace/contracts"
import { useEffect, useRef } from "react"
import { tidyDictation } from "@/lib/api/server"
import { dictation, type RelayDictationAdapter } from "./dictation"

/**
 * The tidy pass on stop: the live words the recogniser settled are sent to a
 * fast model that drops fillers and false starts, and the answer replaces
 * them in the field, in place. Anything the owner typed stays exactly as
 * typed, and every way the pass can go wrong (nothing to tidy, a failure, a
 * wait over `DICTATION_TIDY_MS`, the words edited meanwhile) leaves the live
 * text and says nothing.
 */

/** The composer's field, as the pass reads and writes it. */
export type Field = {
  read: () => string
  write: (text: string) => void
  /** Whether a new dictation has started since, whose baseline a write would undo. */
  dictating: () => boolean
}

/**
 * The last unbroken run of dictated phrases as `text` holds them, or null.
 * Typing between two phrases breaks the run, and the phrases before the
 * break are left as heard.
 */
export function dictatedSpan(text: string, phrases: string[]): string | null {
  for (let i = 0; i < phrases.length; i++) {
    const span = phrases.slice(i).join(" ")
    if (text.includes(span)) return span
  }
  return null
}

async function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

export async function tidyDictated(
  field: Field,
  phrases: string[],
  tidy: (text: string) => Promise<string | null> = (text) =>
    tidyDictation({ data: { text } }),
  ms = DICTATION_TIDY_MS
): Promise<void> {
  const span = dictatedSpan(field.read(), phrases)
  if (!span || !needsTidy(span)) return
  const tidied = await within(
    tidy(span).catch(() => null),
    ms
  )
  if (!tidied) return
  const now = field.read()
  const at = now.lastIndexOf(span)
  if (at < 0 || field.dictating()) return
  field.write(now.slice(0, at) + tidied + now.slice(at + span.length))
}

/** Tidies each dictation that was stopped, once the composer has taken its last words. */
export function DictationTidy({
  adapter = dictation,
}: {
  adapter?: RelayDictationAdapter
}) {
  const aui = useAui()
  const active = useAuiState((s) => s.composer.dictation != null)
  const was = useRef<boolean>(false)
  useEffect(() => {
    if (was.current && !active) {
      const phrases = adapter.take()
      if (phrases.length > 0) {
        const composer = () => aui.composer()
        void tidyDictated(
          {
            read: () => composer().getState().text,
            write: (text) => composer().setText(text),
            dictating: () => composer().getState().dictation != null,
          },
          phrases
        )
      }
    }
    was.current = active
  }, [active, aui, adapter])
  return null
}
