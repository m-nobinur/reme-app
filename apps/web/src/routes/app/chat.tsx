import { createFileRoute, redirect } from "@tanstack/react-router"

// The conversation moved to /app. Old links and bookmarks land there.
export const Route = createFileRoute("/app/chat")({
  beforeLoad: () => {
    throw redirect({ to: "/app", replace: true })
  },
})
