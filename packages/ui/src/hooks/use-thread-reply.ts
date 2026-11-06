import { type AssistantState, useAui, useAuiState } from "@assistant-ui/react"

type Messages = AssistantState["thread"]["messages"]

/** Sends words as the owner's next message, as a card's reply button does. */
export function useReply(): (text: string) => void {
  const aui = useAui()
  return (text) => aui.thread().append(text)
}

/** What `read` finds in the messages after the one this card sits in. */
export function useLater<T>(read: (later: Messages) => T): T {
  return useAuiState((s) => {
    const at = s.thread.messages.findIndex((m) => m.id === s.message.id)
    return read(s.thread.messages.slice(at + 1))
  })
}
