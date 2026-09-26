import { createFileRoute } from "@tanstack/react-router"
import { ChatPage } from "@/chat/chat-page"

export const Route = createFileRoute("/app/")({
  component: ChatPage,
  staticData: { conversation: "New chat" },
  // Client only. The thread is empty until the owner types, so rendering it on
  // the server produces nothing a reader would see, and it is what puts
  // assistant-ui and the AI SDK in the worker: 471 KiB gzip of the 1 MiB
  // budget for markup nobody reads.
  ssr: false,
})
