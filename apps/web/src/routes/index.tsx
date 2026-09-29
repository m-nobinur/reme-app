import { createFileRoute, Link } from "@tanstack/react-router"
import { buttonVariants } from "@workspace/ui/components/button"
import {
  ClosingCta,
  Control,
  Faq,
  Hero,
  SiteFooter,
  SiteHeader,
  Steps,
  Team,
  Work,
} from "@workspace/ui/components/landing"
import { Logo } from "@workspace/ui/components/logo"

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Reme · An AI assistant for small service businesses" },
      {
        name: "description",
        content:
          "Reme answers enquiries, chases quotes and builds your website. Anything involving money or a public promise waits for your approval.",
      },
    ],
  }),
  component: Landing,
})

const NAV = [
  { href: "#work", label: "What it does" },
  { href: "#how", label: "How it works" },
  { href: "#team", label: "Your team" },
  { href: "#control", label: "Control" },
  { href: "#questions", label: "Questions" },
]

const brand = (
  <Link to="/">
    <Logo />
  </Link>
)

const signUp = (
  <Link className={buttonVariants({ size: "lg" })} to="/sign-up">
    Create your account
  </Link>
)

const signIn = (
  <Link
    className={buttonVariants({ size: "lg", variant: "outline" })}
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
        <Work />
        <Steps />
        <Team />
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
