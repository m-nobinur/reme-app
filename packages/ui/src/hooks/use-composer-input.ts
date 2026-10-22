import { createContext, type RefObject, useContext } from "react"

/**
 * The thread's composer input, so a card in the transcript can hand the
 * owner to it: the design tray gives the cursor back when it collapses or
 * finishes, and a proposed quote form's "Make changes" puts the cursor here
 * for the owner to type the change. Outside a thread it holds nothing.
 */
export const ComposerInputContext = createContext<
  RefObject<HTMLTextAreaElement | null>
>({ current: null })

export function useFocusComposer(): () => void {
  const input = useContext(ComposerInputContext)
  return () => input.current?.focus()
}
