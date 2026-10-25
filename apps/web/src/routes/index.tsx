import { ArrowUpRightIcon, CaretDownIcon } from "@phosphor-icons/react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { buttonVariants } from "@workspace/ui/components/button"
import {
  Assistant,
  ClosingCta,
  Control,
  Enquiries,
  Faq,
  Hero,
  Pipeline,
  Setup,
  SiteFooter,
  SiteHeader,
  Website,
  Workforce,
} from "@workspace/ui/components/landing"
import { Logo } from "@workspace/ui/components/logo"
import { signedIn } from "@/lib/auth/signed-in"

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Reme · Your business assistant" },
      {
        name: "description",
        content:
          "Reme answers every enquiry in your voice, gathers what each quote needs and follows up until the customer decides. Routine work runs itself. The decisions stay yours.",
      },
    ],
  }),
  // Decided on the server so a signed-in owner never sees the signed-out header.
  loader: signedIn,
  component: Landing,
})

const NAV = [
  { href: "#assistant", label: "The assistant" },
  { href: "#workforce", label: "The workforce" },
  { href: "#how", label: "How it works" },
  { href: "#control", label: "Your control" },
]

const brand = (
  <Link to="/">
    <Logo />
  </Link>
)

/** The arrow on a call to action, nudging toward where it goes on hover. */
const arrow = (
  <ArrowUpRightIcon
    aria-hidden
    className="transition-transform group-hover/button:translate-x-0.5 group-hover/button:-translate-y-0.5"
    data-icon="inline-end"
  />
)

const howItWorks = (
  <a className={buttonVariants({ size: "lg", variant: "ghost" })} href="#how">
    See how it works
    <CaretDownIcon aria-hidden data-icon="inline-end" />
  </a>
)

/** The way in: the app for a signed-in owner, sign-up for anyone else. */
function Start({
  isSignedIn,
  ...style
}: { isSignedIn: boolean } & Parameters<typeof buttonVariants>[0]) {
  return (
    <Link
      className={buttonVariants(style)}
      to={isSignedIn ? "/app" : "/sign-up"}
    >
      {isSignedIn ? "Open your assistant" : "Get started"}
      {arrow}
    </Link>
  )
}

/** The only page that is public by design. Everything else lives under /app. */
function Landing() {
  const isSignedIn = Route.useLoaderData()
  return (
    <div className="min-h-svh bg-background font-brand text-foreground">
      <SiteHeader
        actions={
          <>
            {isSignedIn ? null : (
              <Link
                className={buttonVariants({
                  variant: "ghost",
                  className: "hidden px-3 text-xs sm:inline-flex",
                })}
                to="/sign-in"
              >
                Sign in
              </Link>
            )}
            <Start
              className="px-4 text-xs"
              isSignedIn={isSignedIn}
              variant="outline"
            />
          </>
        }
        brand={brand}
        nav={NAV}
      />
      <main>
        <Hero
          actions={
            <>
              <Start isSignedIn={isSignedIn} size="lg" />
              {howItWorks}
            </>
          }
        />
        <Assistant />
        <Workforce />
        <Enquiries />
        <Setup />
        <Pipeline />
        <Website />
        <Control />
        <Faq />
        <ClosingCta
          actions={
            <>
              <Start className="h-12 px-8" isSignedIn={isSignedIn} size="lg" />
              {isSignedIn ? null : (
                <Link
                  className={buttonVariants({
                    size: "lg",
                    variant: "outline",
                    className: "h-12 px-8",
                  })}
                  to="/sign-in"
                >
                  Sign in
                </Link>
              )}
            </>
          }
        />
      </main>
      <SiteFooter
        brand={brand}
        columns={[
          {
            title: "Product",
            links: NAV.map((link) => (
              <a href={link.href} key={link.href}>
                {link.label}
              </a>
            )),
          },
          {
            title: "Account",
            links: isSignedIn ? (
              <Link to="/app">Open your assistant</Link>
            ) : (
              <>
                <Link to="/sign-up">Get started</Link>
                <Link to="/sign-in">Sign in</Link>
              </>
            ),
          },
          {
            title: "Legal",
            links: (
              <>
                <Link to="/privacy">Privacy</Link>
                <Link to="/terms">Terms</Link>
              </>
            ),
          },
        ]}
      />
    </div>
  )
}
