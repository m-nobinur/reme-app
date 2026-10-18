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

/** The only page that is public by design. Everything else lives under /app. */
function Landing() {
  return (
    <div className="min-h-svh bg-background font-brand text-foreground">
      <SiteHeader
        actions={
          <>
            <Link
              className={buttonVariants({
                variant: "ghost",
                className: "hidden px-3 text-xs sm:inline-flex",
              })}
              to="/sign-in"
            >
              Sign in
            </Link>
            <Link
              className={buttonVariants({
                variant: "outline",
                className: "px-4 text-xs",
              })}
              to="/sign-up"
            >
              Get started
              {arrow}
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
              <Link className={buttonVariants({ size: "lg" })} to="/sign-up">
                Get started
                {arrow}
              </Link>
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
              <Link
                className={buttonVariants({
                  size: "lg",
                  className: "h-12 px-8",
                })}
                to="/sign-up"
              >
                Get started
                {arrow}
              </Link>
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
            links: (
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
