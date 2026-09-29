import { Link } from "@tanstack/react-router"
import { Logo } from "@workspace/ui/components/logo"
import { ThemeToggle } from "@workspace/ui/components/theme-toggle"
import { LegalFooter } from "./legal-footer"

/**
 * Tailwind has no typography plugin here, so the rendered Markdown is styled
 * from its container.
 */
const PROSE = [
  "[&_h1]:font-semibold [&_h1]:text-3xl [&_h1]:tracking-tight",
  "[&_h2]:mt-10 [&_h2]:font-semibold [&_h2]:text-xl [&_h2]:tracking-tight",
  "[&_p]:mt-4 [&_p]:leading-relaxed",
  "[&_ol]:mt-4 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-6",
  "[&_ul]:mt-4 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-6",
  "[&_a]:underline [&_a]:underline-offset-4",
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:text-sm",
  "[&_table]:mt-4 [&_table]:w-full [&_table]:text-left [&_table]:text-sm",
  "[&_td]:border-b [&_td]:px-2 [&_td]:py-2 [&_td]:align-top [&_td]:text-muted-foreground",
  "[&_th]:border-b [&_th]:px-2 [&_th]:py-2 [&_th]:align-top [&_th]:font-medium",
].join(" ")

/**
 * The privacy policy and the terms. `html` is built from our own Markdown in
 * src/content by the Vite config, never from anything a request carries.
 */
export function LegalPage({ html }: { html: string }) {
  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5">
        <Link to="/">
          <Logo />
        </Link>
        <ThemeToggle />
      </header>
      <main className="mx-auto max-w-3xl overflow-x-auto px-6 pt-8 pb-16">
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: build-time HTML from src/content */}
        <article className={PROSE} dangerouslySetInnerHTML={{ __html: html }} />
      </main>
      <LegalFooter />
    </div>
  )
}
