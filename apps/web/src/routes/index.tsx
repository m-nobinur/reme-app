import { createFileRoute, Link } from "@tanstack/react-router"
import { buttonVariants } from "@workspace/ui/components/button"
import { ThemeToggle } from "@workspace/ui/components/theme-toggle"

export const Route = createFileRoute("/")({ component: Landing })

/** The only page that is public by design. Everything else lives under /app. */
function Landing() {
  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5">
        <span className="font-semibold tracking-tight">Reme</span>
        <ThemeToggle />
      </header>
      <main className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="max-w-2xl text-balance font-semibold text-4xl tracking-tight">
          An AI business assistant for small service businesses.
        </h1>
        <p className="mt-4 max-w-prose text-lg text-muted-foreground">
          Reme runs the work around the work: the questions, the approvals, the
          follow-ups and the website.
        </p>
        <Link className={buttonVariants({ className: "mt-8" })} to="/app">
          Open the dashboard
        </Link>
      </main>
    </div>
  )
}
