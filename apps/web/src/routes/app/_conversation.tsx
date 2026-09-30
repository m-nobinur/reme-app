import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router"
import { ThreadPending } from "@workspace/ui/components/assistant/thread-pending"

/**
 * The conversation, around `/app` and `/app/c/$id` both, so one runtime
 * outlives the move from a new chat to its stored address: the first send
 * stores the conversation and the address follows it, with no remount.
 *
 * Client only. The thread is empty until the owner types or history loads,
 * so the server has nothing to render for it.
 */
export const Route = createFileRoute("/app/_conversation")({
  // `ssr: false` (and `ClientOnly`) keep the chat in the server build:
  // assistant-ui, mdast and micromark sat in the worker unrendered, even
  // behind a pruned branch, since the split chunk imported the module for
  // its side effects. Vite replaces `import.meta.env.SSR` statically, and a
  // dynamic import only in the client branch leaves no chat chunk in
  // dist/server at all.
  component: import.meta.env.SSR
    ? () => null
    : lazyRouteComponent(() => import("@/chat/chat-page"), "ChatPage"),
  ssr: false,
  // The server renders this while the chat chunk loads. It is the thread's
  // own shape, and it shows at once: the router's default waits 1s before
  // showing a pending screen, which leaves a blank page until then.
  pendingComponent: ThreadPending,
  pendingMs: 0,
})
