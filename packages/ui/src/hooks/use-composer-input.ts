import { createContext, type RefObject, useContext } from "react"

/**
 * The thread's composer input, so a card in the transcript can hand the
 * owner to it: "I'd change something" on a proposed quote form puts the
 * cursor where the change is written. Outside a thread it holds nothing.
 */
export const ComposerInputContext = createContext<
  RefObject<HTMLTextAreaElement | null>
>({ current: null })

export function useFocusComposer(): () => void {
  const input = useContext(ComposerInputContext)
  return () => input.current?.focus()
}

/**
 * Hands the owner to the composer with `text` already in it, as a prefix to
 * finish. An unsent draft is never overwritten: the cursor just goes there.
 * The value is set the way a keystroke would, so the controlled input and
 * the runtime behind it see it.
 */
export function useComposeWith(): (text: string) => void {
  const input = useContext(ComposerInputContext)
  return (text) => {
    const el = input.current
    if (!el) return
    if (el.value === "") {
      const set = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set
      set?.call(el, text)
      el.dispatchEvent(new Event("input", { bubbles: true }))
    }
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }
}
