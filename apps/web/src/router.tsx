import {
  createRouter as createTanStackRouter,
  Link,
} from "@tanstack/react-router"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { EmptyState } from "@workspace/ui/components/empty-state"
import { LoadingState } from "@workspace/ui/components/loading-state"
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

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,

    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultPendingComponent: () => <LoadingState className="m-6" />,
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: RouteNotFound,
  })

  return router
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
