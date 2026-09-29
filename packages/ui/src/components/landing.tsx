import { CaretDownIcon } from "@phosphor-icons/react"
import { DEEP_SURFACE } from "@workspace/ui/components/auth-aside"
import { Badge } from "@workspace/ui/components/badge"
import { buttonVariants } from "@workspace/ui/components/button"
import { StaffTree } from "@workspace/ui/components/staff-tree"
import { ThemeToggle } from "@workspace/ui/components/theme-toggle"
import { cn } from "@workspace/ui/lib/utils"
import type { ReactNode } from "react"

/**
 * Reme's own front page, as sections.
 *
 * Presentational only, and links come in as slots so this package imports no
 * router. Every claim on the page is one the product plan makes for the first
 * release: nothing here promises payments, SMS, WhatsApp or calendar sync,
 * which are later. There is no testimonial, customer count or price, because
 * none of them exists yet and an invented one would read as real.
 */

const CONTAINER = "mx-auto w-full max-w-6xl px-6"
const SECTION = "scroll-mt-16 border-border border-t py-20 sm:py-28"

type NavLink = { href: string; label: string }

/** Sticky, with the page's own anchors, so a long page keeps its way around. */
function SiteHeader({
  brand,
  nav,
  actions,
}: {
  brand: ReactNode
  nav: NavLink[]
  actions: ReactNode
}) {
  return (
    <header className="sticky top-0 z-40 border-border border-b bg-background/85 backdrop-blur">
      <div className={cn(CONTAINER, "flex h-16 items-center gap-8")}>
        {brand}
        <nav aria-label="On this page" className="hidden md:block">
          <ul className="flex gap-6 text-muted-foreground text-sm">
            {nav.map((link) => (
              <li key={link.href}>
                <a
                  className="rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring"
                  href={link.href}
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {actions}
          <ThemeToggle />
        </div>
      </div>
    </header>
  )
}

/**
 * One enquiry, start to finish, drawn as the product shows it: a customer
 * writes at night, the assistant answers, and the quote waits for the owner.
 *
 * Labelled as an example in its caption and built from plain text, because it
 * is an illustration and not a screenshot of anyone's business. The two
 * buttons are spans for the same reason: nothing here can be pressed.
 */
function LeadPreview() {
  return (
    <figure className="w-full max-w-md justify-self-center lg:justify-self-end">
      <div className="flex flex-col gap-3 rounded-4xl bg-card p-5 text-card-foreground shadow-sm ring-1 ring-foreground/5 sm:p-6 dark:ring-foreground/10">
        <div className="flex items-center justify-between">
          <Badge variant="secondary">Website chat</Badge>
          <span className="text-muted-foreground text-xs">
            Tuesday, 11:42 pm
          </span>
        </div>

        <p className="max-w-[85%] rounded-3xl rounded-bl-md bg-muted px-4 py-2.5 text-sm">
          Hi, could you quote a deep clean for a three-bed semi? Saturday if
          possible.
        </p>
        <p className="ml-auto max-w-[85%] rounded-3xl rounded-br-md bg-primary px-4 py-2.5 text-primary-foreground text-sm">
          Happy to. Is the oven included, and are there any pets? I will have a
          price for you shortly.
        </p>

        <div className="mt-2 rounded-3xl bg-muted p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="font-medium text-sm">Quote for your approval</p>
            <Badge variant="outline">Approval</Badge>
          </div>
          <p className="mt-1 text-muted-foreground text-sm">
            Deep clean, three-bed semi, Saturday. Inside your price rules.
          </p>
          <p className="mt-3 font-semibold text-2xl tracking-tight">£185</p>
          <div aria-hidden className="mt-3 flex gap-2">
            <span className={buttonVariants({ size: "sm" })}>Approve</span>
            <span
              className={buttonVariants({ size: "sm", variant: "outline" })}
            >
              Change
            </span>
          </div>
        </div>
      </div>
      <figcaption className="mt-3 text-center text-muted-foreground text-xs lg:text-right">
        An example enquiry. The reply is sent for you; the quote waits for you.
      </figcaption>
    </figure>
  )
}

function Hero({ actions }: { actions: ReactNode }) {
  return (
    <section className="relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(50% 60% at 85% 0%, color-mix(in oklch, var(--primary) 12%, transparent), transparent 70%)",
        }}
      />
      <div
        className={cn(
          CONTAINER,
          "relative grid items-center gap-14 py-16 sm:py-24 lg:grid-cols-[1.15fr_0.85fr] lg:py-28"
        )}
      >
        <div>
          <h1 className="text-balance font-semibold text-5xl leading-[1.05] tracking-tight sm:text-6xl">
            Never lose a job to a slow reply.
          </h1>
          <p className="mt-6 max-w-xl text-lg text-muted-foreground leading-relaxed">
            Reme is an AI assistant for small service businesses, starting with
            cleaning. It answers enquiries in your voice, chases quotes and
            builds your website. Anything involving money or a public promise
            waits for your approval.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">{actions}</div>
        </div>
        <LeadPreview />
      </div>
    </section>
  )
}

/** A heading block that sits beside its content from `lg`, so long lists read as a page rather than a stack. */
function SectionHeading({
  title,
  children,
}: {
  title: string
  children?: ReactNode
}) {
  return (
    <div className="lg:sticky lg:top-28 lg:self-start">
      <h2 className="text-balance font-semibold text-3xl tracking-tight sm:text-4xl">
        {title}
      </h2>
      {children ? (
        <p className="mt-4 max-w-md text-muted-foreground leading-relaxed">
          {children}
        </p>
      ) : null}
    </div>
  )
}

const WORK = [
  {
    title: "Replies at any hour",
    text: "Website chat, quote forms and email land in one pipeline. Reme answers in your voice from prices, hours and policies you have confirmed, and it says it is your AI assistant.",
  },
  {
    title: "Chases what goes quiet",
    text: "Unanswered quotes and stale leads get a follow-up on a schedule you set. When there is nothing worth doing or reporting, it does nothing.",
  },
  {
    title: "Prepares the decisions",
    text: "Quotes outside your rules and other exceptions reach you with the context to decide, and a one-tap approval.",
  },
  {
    title: "Builds and runs your website",
    text: "A hosted site on your own remeai.co.uk address, or your domain when you are ready. Its quote form and chat feed the same assistant.",
  },
] as const

function Work() {
  return (
    <section className={SECTION} id="work">
      <div className={cn(CONTAINER, "grid gap-12 lg:grid-cols-[0.8fr_1.2fr]")}>
        <SectionHeading title="The work around the work">
          Most small businesses lose jobs to attention, not to price. Enquiries
          wait, quotes go unchased and the website drifts out of date.
        </SectionHeading>
        <dl className="divide-y divide-border border-border border-y">
          {WORK.map((item) => (
            <div
              className="py-6 sm:grid sm:grid-cols-[13rem_1fr] sm:gap-8"
              key={item.title}
            >
              <dt className="font-medium">{item.title}</dt>
              <dd className="mt-2 text-muted-foreground leading-relaxed sm:mt-0">
                {item.text}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}

const STEPS = [
  {
    title: "Enquiry arrives",
    text: "From your website chat, a quote form or email.",
  },
  {
    title: "Reme replies",
    text: "Straight away, in your voice, asking only what it needs to quote.",
  },
  {
    title: "Quote prepared",
    text: "Built from the price rules you approved, not guessed.",
  },
  {
    title: "Follow-up",
    text: "If the customer goes quiet, Reme chases on your schedule.",
  },
  {
    title: "You approve",
    text: "Anything outside your rules comes to you first. Then the job is booked.",
  },
] as const

/** A real sequence, so the numbers are information and not decoration. */
function Steps() {
  return (
    <section className={SECTION} id="how">
      <div className={CONTAINER}>
        <h2 className="max-w-2xl text-balance font-semibold text-3xl tracking-tight sm:text-4xl">
          From first message to booked job
        </h2>
        <ol className="mt-12 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-5">
          {STEPS.map((step, index) => (
            <li className="border-border border-t pt-5" key={step.title}>
              <span className="font-medium text-primary text-sm tabular-nums">
                {index + 1}
              </span>
              <h3 className="mt-2 font-medium">{step.title}</h3>
              <p className="mt-2 text-muted-foreground text-sm leading-relaxed">
                {step.text}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}

function Team() {
  return (
    <section className={SECTION} id="team">
      <div
        className={cn(
          CONTAINER,
          "grid items-center gap-12 lg:grid-cols-2 lg:gap-20"
        )}
      >
        <div>
          <h2 className="text-balance font-semibold text-3xl tracking-tight sm:text-4xl">
            One point of contact, a small team behind it
          </h2>
          <p className="mt-4 max-w-md text-muted-foreground leading-relaxed">
            You talk to the Chief of Staff. It hands work to specialist staff
            and reports back. You can rename them, pause them, or hire the next
            one when the business needs it.
          </p>
        </div>
        <StaffTree
          className="[--ground:var(--background)] [--on:var(--primary)]"
          lead={{
            name: "Chief of Staff",
            role: "Answers you, delegates, reviews",
          }}
          reports={[
            { name: "Developer", role: "Builds your website" },
            { name: "Client Services", role: "Talks to customers" },
            {
              name: "Booking Coordinator",
              role: "Hire when ready",
              open: true,
            },
            { name: "Growth", role: "Hire when ready", open: true },
          ]}
        />
      </div>
    </section>
  )
}

const ON_ITS_OWN = [
  "Answer a customer from your confirmed facts",
  "Log a lead and ask the qualifying questions",
  "Schedule a follow-up or send a reminder",
  "Prepare a quote inside your price rules",
] as const

const WAITS_FOR_YOU = [
  "A quote outside your standard rules",
  "Booking a slot or promising a callback time",
  "Publishing a change to your website",
  "Refunds, discounts beyond policy and domain changes. These never become automatic.",
] as const

function Control() {
  return (
    <section
      className={cn(DEEP_SURFACE, "scroll-mt-16 py-20 sm:py-28")}
      id="control"
    >
      <div className={cn(CONTAINER, "grid gap-12 lg:grid-cols-[0.8fr_1.2fr]")}>
        <div>
          <h2 className="text-balance font-semibold text-3xl tracking-tight sm:text-4xl">
            Routine work runs itself. Big decisions stay yours.
          </h2>
          <p className="mt-4 max-w-md leading-relaxed">
            The line between the two is enforced on the server, not left to the
            conversation. A customer cannot talk the assistant past it, and
            neither can an email or a web page.
          </p>
        </div>
        <div className="grid gap-10 sm:grid-cols-2">
          <div>
            <h3 className="border-(--on)/30 border-b pb-3 font-medium">
              Handled on its own
            </h3>
            <ul className="mt-4 flex flex-col gap-3 text-sm leading-relaxed">
              {ON_ITS_OWN.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="border-(--on)/30 border-b pb-3 font-medium">
              Waits for your approval
            </h3>
            <ul className="mt-4 flex flex-col gap-3 text-sm leading-relaxed">
              {WAITS_FOR_YOU.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  )
}

const QUESTIONS = [
  {
    q: "Who is Reme for?",
    a: "Small service businesses. We are starting with residential and commercial cleaning, where a fast reply often decides who wins the job.",
  },
  {
    q: "Will it message my customers without asking me?",
    a: "It answers questions, asks qualifying questions and sends reminders on its own. A quote outside your rules, a booking, a promised callback time or a change to your website waits for your approval.",
  },
  {
    q: "Does it pretend to be a person?",
    a: "No. It says it is your business's AI assistant, says when it does not know something, and never says an action worked before the system confirms it.",
  },
  {
    q: "Do I have to configure it?",
    a: "You set it up by talking to the Chief of Staff, which asks only what it cannot find out itself. Your prices, hours and policies are saved as facts you can review and edit.",
  },
  {
    q: "What if a customer tries to break the rules?",
    a: "Customers, emails and web pages supply facts, never instructions. Permissions are enforced on the server, so repeating a request does not make it allowed.",
  },
] as const

/** Native disclosure, so it works before hydration and needs no script. */
function Faq() {
  return (
    <section className={SECTION} id="questions">
      <div className={cn(CONTAINER, "grid gap-12 lg:grid-cols-[0.8fr_1.2fr]")}>
        <SectionHeading title="Questions" />
        <div className="divide-y divide-border border-border border-y">
          {QUESTIONS.map((item) => (
            <details className="group py-5" key={item.q}>
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                {item.q}
                <CaretDownIcon
                  aria-hidden
                  className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
                />
              </summary>
              <p className="mt-3 max-w-prose text-muted-foreground leading-relaxed">
                {item.a}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}

function ClosingCta({ actions }: { actions: ReactNode }) {
  return (
    <section className={SECTION}>
      <div className={CONTAINER}>
        <h2 className="max-w-2xl text-balance font-semibold text-4xl tracking-tight sm:text-5xl">
          Set up your workspace in a minute.
        </h2>
        <p className="mt-4 max-w-xl text-muted-foreground leading-relaxed">
          Nothing is published, and no customer is contacted, until you approve
          it.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">{actions}</div>
      </div>
    </section>
  )
}

function SiteFooter({ brand, links }: { brand: ReactNode; links: ReactNode }) {
  return (
    <footer className="border-border border-t">
      <div
        className={cn(
          CONTAINER,
          "flex flex-col gap-6 py-10 text-muted-foreground text-sm sm:flex-row sm:items-center sm:justify-between"
        )}
      >
        <div className="flex flex-col gap-2">
          <span className="text-foreground">{brand}</span>
          <p>Operated from the United Kingdom.</p>
        </div>
        <nav aria-label="Legal and account" className="flex gap-6">
          {links}
        </nav>
      </div>
    </footer>
  )
}

export {
  ClosingCta,
  Control,
  Faq,
  Hero,
  SiteFooter,
  SiteHeader,
  Steps,
  Team,
  Work,
}
