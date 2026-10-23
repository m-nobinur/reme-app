import "@/lib/zod-jitless"
import {
  createRouter as createTanStackRouter,
  Link,
} from "@tanstack/react-router"
import { getGlobalStartContext } from "@tanstack/react-start"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { EmptyState } from "@workspace/ui/components/empty-state"
import { LoadingState } from "@workspace/ui/components/loading-state"
import type { PanelPress } from "@workspace/ui/lib/panel"
import { routeTree } from "./routeTree.gen"

// The three route states, set once here so every route gets the same ones and
// no screen has to remember to. A route overrides one only when it has a
// better local answer.

function RouteError({ reset }: { reset: () => void }) {
  return (
    <EmptyState
      action={
        <Button onClick={reset} variant="outline">
          Try again
        </Button>
      }
      className="m-6"
      // The thrown error is deliberately not rendered: it is a raw exception
      // string, which is not a shape we show anyone.
      description="This screen could not be loaded. Nothing was changed."
      role="alert"
      title="Something went wrong"
    />
  )
}

function RouteNotFound() {
  return (
    <EmptyState
      action={
        <Link className={buttonVariants({ variant: "outline" })} to="/">
          Go to the start
        </Link>
      }
      className="m-6"
      description="The page you asked for does not exist."
      title="Page not found"
    />
  )
}

/**
 * This request's CSP nonce, from `lib/csp.ts`. None in the browser, and none
 * on the server paths that build a router outside the request's context (a
 * server function's redirect), which render no HTML.
 */
function requestNonce(): string | undefined {
  try {
    return getGlobalStartContext()?.nonce
  } catch {
    return undefined
  }
}

export function getRouter() {
  // The workspace scrolls its <main>, not the window, so the router has to be
  // told to reset it. Only on a new visit, though: after restoring an element
  // on Back, the router resets the reset list whenever the window had nothing
  // to restore, which in this layout is always. So <main> is left out of the
  // list on Back, and its restored position stands.
  let goingBack = false
  const router = createTanStackRouter({
    routeTree,

    scrollRestoration: true,
    scrollToTopSelectors: [
      () => (goingBack ? null : document.getElementById("main")),
    ],
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultPendingComponent: () => <LoadingState className="m-6" />,
    // The default holds a pending screen for 500ms once it shows, so a route
    // whose data is ready keeps its skeleton on screen for half a second.
    defaultPendingMinMs: 0,
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: RouteNotFound,
    ssr: { nonce: requestNonce() },
  })
  // Back lands on a lower history index. Forward looks like a new visit and
  // opens at the top.
  router.subscribe("onBeforeNavigate", ({ fromLocation, toLocation }) => {
    goingBack =
      !!fromLocation &&
      toLocation.state.__TSR_index < fromLocation.state.__TSR_index
  })

  return router
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
  interface HistoryState {
    /**
     * Set fresh by "New chat", so a click on /app while already there still
     * starts a new thread.
     */
    chat?: string
    /**
     * Set fresh by a link that sends the owner to the panel: it opens on
     * arrival, with focus on `focus` when that is set.
     */
    panel?: PanelPress
    /** Sent as the first message of the new chat `chat` starts. */
    ask?: string
    /**
     * Set fresh by the panel's Request changes: the chat's composer takes
     * the mode, once per `key`, and the owner's next send carries it.
     */
    compose?: { mode: "site_change"; key: string }
  }
  interface StaticDataRouteOption {
    /**
     * The route is the conversation, which takes the full height; the value is
     * the top bar's title for it.
     */
    conversation?: string
  }
}
