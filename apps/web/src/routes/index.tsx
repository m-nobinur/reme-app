import { createFileRoute, Link } from "@tanstack/react-router"
import { buttonVariants } from "@workspace/ui/components/button"
import {
  ClosingCta,
  Control,
  Faq,
  Features,
  Hero,
  SiteFooter,
  SiteHeader,
  Steps,
} from "@workspace/ui/components/landing"
import { Logo } from "@workspace/ui/components/logo"

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Reme · The AI assistant for cleaning businesses" },
      {
        name: "description",
        content:
          "Reme answers every enquiry in your voice, gathers what each quote request needs and follows up until the customer decides. You approve everything that matters.",
      },
    ],
  }),
  component: Landing,
})

const NAV = [
  { href: "#features", label: "Features" },
  { href: "#how", label: "How it works" },
  { href: "#control", label: "Control" },
  { href: "#questions", label: "FAQ" },
]

const brand = (
  <Link to="/">
    <Logo />
  </Link>
)

const signUp = (
  <Link
    className={buttonVariants({ size: "lg", className: "h-12 px-6" })}
    to="/sign-up"
  >
    Get started
  </Link>
)

const signIn = (
  <Link
    className={buttonVariants({
      size: "lg",
      variant: "outline",
      className: "h-12 px-6",
    })}
    to="/sign-in"
  >
    Sign in
  </Link>
)

/** The only page that is public by design. Everything else lives under /app. */
function Landing() {
  return (
    <div className="min-h-svh bg-background text-foreground">
      <SiteHeader
        actions={
          <>
            <Link
              className={buttonVariants({ variant: "ghost" })}
              to="/sign-in"
            >
              Sign in
            </Link>
            <Link className={buttonVariants()} to="/sign-up">
              Get started
            </Link>
          </>
        }
        brand={brand}
        nav={NAV}
      />
      <main>
        <Hero
          actions={
            <>
              {signUp}
              {signIn}
            </>
          }
        />
        <Features />
        <Steps />
        <Control />
        <Faq />
        <ClosingCta actions={signUp} />
      </main>
      <SiteFooter
        brand={brand}
        links={
          <>
            <Link className="hover:text-foreground" to="/privacy">
              Privacy
            </Link>
            <Link className="hover:text-foreground" to="/terms">
              Terms
            </Link>
            <Link className="hover:text-foreground" to="/sign-in">
              Sign in
            </Link>
          </>
        }
      />
    </div>
  )
}
