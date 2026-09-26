import { createFileRoute } from "@tanstack/react-router"

// The address of a new chat. `_conversation` renders the conversation.
export const Route = createFileRoute("/app/_conversation/")({
  staticData: { conversation: "New chat" },
})
