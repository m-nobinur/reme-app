import { Logo } from "@workspace/ui/components/logo"
import { ThemeToggle } from "@workspace/ui/components/theme-toggle"
import { cn } from "@workspace/ui/lib/utils"
import { type ComponentProps, type ReactNode, useEffect, useRef } from "react"

/**
 * Neutralises a form submit that arrives before React can handle it.
 *
 * The bug this exists for: every form in the sign-in flow submits through a
 * server function, so the handler is React's and lives in JavaScript. Between
 * the browser parsing the markup and React hydrating it, the form is a plain
 * form with no handler, and a click in that window submits it natively. With no
 * `action` it posts back to its own URL, which no route answers, so the typed
 * credentials are thrown away and the person lands on the page they started on
 * or on "We could not reach the sign-in service". Measured on staging: five
 * failures in thirty attempts, none of which reached a server function and none
 * of which created a session.
 *
 * The fix is not a spinner over the button. The submit is cancelled and
 * remembered, and `AuthForm` replays it the moment it hydrates, so the click
 * lands late instead of being lost. Nothing is typed twice and nothing is
 * discarded: the values stay in the DOM the whole time, which is why the fields
 * in this flow are uncontrolled.
 *
 * It has to run as a blocking inline script in `<head>`, before the body is
 * parsed, or there is a window in front of the window it closes. Capturing, so
 * it runs before any handler React later delegates from the root.
 */
const formGuardScript = `document.addEventListener("submit",function(e){var f=e.target;if(f&&f.dataset&&f.dataset.authForm==="true"&&f.dataset.hydrated!=="true"){e.preventDefault();f.dataset.submitQueued="true"}},true)`

/**
 * The frame every page in the sign-in flow renders into: one centred panel on
 * the page background, the product's mark above it, and a single line of onward
 * navigation below.
 *
 * The wordmark and the footer are slots so this package still imports no router.
 */
function AuthCard({
  brand = <Logo />,
  title,
  description,
  footer,
  className,
  children,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  brand?: ReactNode
  title: string
  description?: ReactNode
  footer?: ReactNode
}) {
  return (
    <div
      className={cn(
        "relative flex min-h-svh flex-col items-center justify-center gap-6 bg-background px-4 py-10 text-foreground",
        className
      )}
      {...props}
    >
      {/* The one place in the product a person can be before they have an
          account, so it is the one place the theme control has to exist too. */}
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>

      {brand}

      <main className="w-full max-w-sm rounded-3xl border border-border bg-card p-6 shadow-xs sm:p-8">
        <h1 className="font-semibold text-xl tracking-tight">{title}</h1>
        {description ? (
          <p className="mt-2 text-muted-foreground text-sm leading-relaxed">
            {description}
          </p>
        ) : null}
        <div className="mt-6">{children}</div>
      </main>

      {footer ? (
        <p className="text-muted-foreground text-sm">{footer}</p>
      ) : null}
    </div>
  )
}

/** Everything a form in this flow submits, read off the DOM rather than state. */
type AuthFormValues = Record<string, string>

/**
 * The vertical rhythm inside an AuthCard, and the only place these forms are
 * submitted from.
 *
 * It owns `preventDefault` rather than leaving it to eight callers, and it hands
 * over the field values instead of the event, because a page that has to
 * remember to cancel the default action is a page that will one day forget. The
 * values come from the form itself, so the inputs stay uncontrolled and a
 * password typed before hydration is still there afterwards.
 *
 * `method="post"` matters for the same window `formGuardScript` covers: a form
 * with no method defaults to GET, and if the guard ever failed to load, a GET
 * submit would put the password in the query string, the address bar, the
 * history and every log in between. Belt as well as braces.
 */
function AuthForm({
  className,
  onSubmit,
  ...props
}: Omit<ComponentProps<"form">, "onSubmit"> & {
  onSubmit?: (values: AuthFormValues) => void | Promise<void>
}) {
  const ref = useRef<HTMLFormElement>(null)

  // An effect rather than a ref callback: it is the first point at which the
  // committed `onSubmit` below is reachable through React's delegated
  // listener, which is where the replayed submit has to land.
  useEffect(() => {
    const form = ref.current
    // biome-ignore lint/suspicious/noUnnecessaryConditions: biome reads `useRef<T>(null)` as non-nullable and tsc does not, and tsc is right — without this branch `pnpm typecheck` fails with TS18047 on every line below
    if (!form) {
      return
    }
    // Opens the gate in the guard script above. From here the form handles its
    // own submits.
    form.dataset.hydrated = "true"
    if (form.dataset.submitQueued === "true") {
      delete form.dataset.submitQueued
      // Not a direct call to the handler: `requestSubmit` fires a real submit
      // event, so the queued click runs constraint validation and reaches React
      // by exactly the path a live click would.
      form.requestSubmit()
    }
  }, [])

  return (
    <form
      className={cn("flex flex-col gap-4", className)}
      data-auth-form="true"
      method="post"
      onSubmit={(event) => {
        event.preventDefault()
        const values: AuthFormValues = {}
        for (const [key, value] of new FormData(event.currentTarget)) {
          if (typeof value === "string") {
            values[key] = value
          }
        }
        void onSubmit?.(values)
      }}
      ref={ref}
      {...props}
    />
  )
}

export type { AuthFormValues }
export { AuthCard, AuthForm, formGuardScript }
