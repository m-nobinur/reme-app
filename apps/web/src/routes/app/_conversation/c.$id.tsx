import { createFileRoute } from "@tanstack/react-router"

// A stored conversation's address. `_conversation` renders it; the top bar takes its
// title from the rail's list, and says "Conversation" when it is not there.
export const Route = createFileRoute("/app/_conversation/c/$id")({
  staticData: { conversation: "Conversation" },
})
