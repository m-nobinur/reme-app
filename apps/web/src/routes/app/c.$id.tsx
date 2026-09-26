import { createFileRoute } from "@tanstack/react-router"
import { ChatPage } from "@/chat/chat-page"

// Client only, for the reason the index route gives.
export const Route = createFileRoute("/app/c/$id")({
  component: ChatPage,
  ssr: false,
})
