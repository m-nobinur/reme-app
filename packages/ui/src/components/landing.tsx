import {
  ArrowsClockwiseIcon,
  CaretDownIcon,
  CheckIcon,
  GlobeIcon,
  HandTapIcon,
  type Icon,
  LightningIcon,
  ReceiptIcon,
} from "@phosphor-icons/react"
import { DEEP_SURFACE } from "@workspace/ui/components/auth-aside"
import { MorningSummary } from "@workspace/ui/components/morning-summary"
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
const SECTION = "scroll-mt-16 border-border border-t py-24 sm:py-32"

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
      <div className={cn(CONTAINER, "flex h-16 items-center gap-10")}>
        {brand}
        <nav aria-label="On this page" className="hidden md:block">
          <ul className="flex gap-8 text-muted-foreground text-sm">
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

/** The heading every section after the hero opens with, so they all start the same way. */
function SectionHeading({
  title,
  children,
  className,
}: {
  title: string
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={cn("max-w-2xl", className)}>
      <h2 className="text-balance font-semibold text-3xl tracking-tight sm:text-4xl">
        {title}
      </h2>
      {children ? (
        <p className="mt-4 text-lg text-muted-foreground leading-relaxed">
          {children}
        </p>
      ) : null}
    </div>
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
            "radial-gradient(50% 60% at 85% 0%, color-mix(in oklch, var(--primary) 14%, transparent), transparent 70%)",
        }}
      />
      <div
        className={cn(
          CONTAINER,
          "relative grid items-center gap-16 py-20 sm:py-28 lg:grid-cols-[1.1fr_0.9fr]"
        )}
      >
        <div>
          <h1 className="text-balance font-semibold text-5xl leading-[1.05] tracking-tight sm:text-6xl">
            Never lose a job to a slow reply.
          </h1>
          <p className="mt-6 max-w-xl text-lg text-muted-foreground leading-relaxed">
            Reme is the AI assistant for cleaning businesses. It answers every
            enquiry in your voice, gathers what each quote request needs and
            follows up until the customer decides. You stay in charge of
            everything that matters.
          </p>
          <div className="mt-10 flex flex-wrap gap-3">{actions}</div>
        </div>
        <MorningSummary className="mx-auto max-w-md lg:mr-0" />
      </div>
    </section>
  )
}

const FEATURES: { icon: Icon; title: string; text: string }[] = [
  {
    icon: LightningIcon,
    title: "Replies in minutes, day or night",
    text: "Enquiries from your website, quote forms and email land in one place. Reme answers each one in your voice, from the services, hours and policies you have confirmed.",
  },
  {
    icon: ReceiptIcon,
    title: "Quote requests, ready to answer",
    text: "Reme asks each customer what the job involves, then brings you the request with everything you need to quote. The quote is yours to set.",
  },
  {
    icon: ArrowsClockwiseIcon,
    title: "Follow-ups that never slip",
    text: "Quiet leads and unanswered quotes get a timely nudge on the schedule you set, so no job is lost to silence.",
  },
  {
    icon: GlobeIcon,
    title: "A website that brings in work",
    text: "Reme builds and keeps up a professional site from your business details, on a remeai.co.uk address or your own domain.",
  },
]

function Features() {
  return (
    <section className={SECTION} id="features">
      <div className={CONTAINER}>
        <SectionHeading title="Everything between the enquiry and the booked job">
          Most jobs are lost to attention, not price. Reme does the work that
          slips when you are busy with the work itself.
        </SectionHeading>
        {/* One frame split into cells, not four floating cards: the hairlines
            are the grid's own gap showing the border colour through. */}
        <ul className="mt-14 grid gap-px overflow-hidden rounded-3xl bg-border ring-1 ring-border sm:grid-cols-2">
          {FEATURES.map((item) => (
            <li className="bg-background p-8 sm:p-10" key={item.title}>
              <span className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary">
                <item.icon aria-hidden className="size-5.5" />
              </span>
              <h3 className="mt-6 font-semibold text-lg">{item.title}</h3>
              <p className="mt-2 text-muted-foreground leading-relaxed">
                {item.text}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

const STEPS = [
  {
    title: "Tell Reme about your business",
    text: "Answer a few questions in plain conversation. Your services, hours and service area are saved as details you can review at any time.",
  },
  {
    title: "Go live",
    text: "Reme builds your website and starts answering enquiries once you have approved what it will say.",
  },
  {
    title: "Approve what matters",
    text: "Routine work runs on its own. Quotes outside your rules and changes to your website wait for one tap from you.",
  },
] as const

/** A real sequence, so the numbers are information and not decoration. */
function Steps() {
  return (
    <section className={SECTION} id="how">
      <div className={CONTAINER}>
        <SectionHeading title="Up and running in an afternoon">
          No setup forms and no training. You talk, Reme learns how your
          business works.
        </SectionHeading>
        <ol className="mt-14 grid gap-10 md:grid-cols-3 md:gap-8">
          {STEPS.map((step, index) => (
            <li key={step.title}>
              <span className="grid size-10 place-items-center rounded-full bg-primary font-semibold text-primary-foreground text-sm tabular-nums">
                {index + 1}
              </span>
              <h3 className="mt-6 font-semibold text-lg">{step.title}</h3>
              <p className="mt-2 text-muted-foreground leading-relaxed">
                {step.text}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}

const ON_ITS_OWN = [
  "Answer customers from your confirmed details",
  "Log every new lead and ask the right questions",
  "Follow up quiet leads and unanswered quotes",
  "Gather the details each quote request needs",
] as const

const WAITS_FOR_YOU = [
  "Quotes outside your usual rules",
  "Bookings and promised callback times",
  "Any change to your website",
  "Refunds, discounts and domain changes, always",
] as const

function ControlList({
  title,
  items,
  icon: ItemIcon,
}: {
  title: string
  items: readonly string[]
  icon: Icon
}) {
  return (
    <div className="rounded-3xl bg-(--on)/8 p-8 ring-(--on)/15 ring-1">
      <h3 className="font-semibold text-lg">{title}</h3>
      <ul className="mt-6 flex flex-col gap-4">
        {items.map((item) => (
          <li className="flex gap-3 leading-relaxed" key={item}>
            <ItemIcon aria-hidden className="mt-1 size-4.5 shrink-0" />
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Control() {
  return (
    <section
      className={cn(DEEP_SURFACE, "scroll-mt-16 py-24 sm:py-32")}
      id="control"
    >
      <div className={cn(CONTAINER, "grid gap-14 lg:grid-cols-[0.8fr_1.2fr]")}>
        <div>
          <h2 className="text-balance font-semibold text-3xl tracking-tight sm:text-4xl">
            Routine work runs itself. Big decisions stay yours.
          </h2>
          <p className="mt-4 text-(--on)/80 text-lg leading-relaxed">
            You decide where the line sits, and Reme holds it. No customer,
            email or web page can talk it past your rules.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <ControlList
            icon={CheckIcon}
            items={ON_ITS_OWN}
            title="Handled for you"
          />
          <ControlList
            icon={HandTapIcon}
            items={WAITS_FOR_YOU}
            title="Waits for your approval"
          />
        </div>
      </div>
    </section>
  )
}

const QUESTIONS = [
  {
    q: "Who is Reme for?",
    a: "Small service businesses, starting with residential and commercial cleaning, where a fast reply often decides who wins the job.",
  },
  {
    q: "Do I need a website already?",
    a: "No. Reme builds one for you on a remeai.co.uk address, and moves it to your own domain when you are ready.",
  },
  {
    q: "Will it message my customers without asking me?",
    a: "It answers questions, collects details and sends follow-ups on its own. Quotes outside your rules, bookings and changes to your website wait for your approval.",
  },
  {
    q: "Does it pretend to be a person?",
    a: "No. It says it is your business's AI assistant, says when it does not know something, and never claims an action worked before it has.",
  },
  {
    q: "How long does setup take?",
    a: "Most owners are done in one sitting. Reme asks only what it cannot work out itself, and everything you tell it can be reviewed and edited later.",
  },
  {
    q: "What if a customer tries to talk it round?",
    a: "Customers, emails and web pages can give Reme information, never instructions. Your rules are enforced by the system, so asking twice does not change the answer.",
  },
] as const

/** Native disclosure, so it works before hydration and needs no script. */
function Faq() {
  return (
    <section className={SECTION} id="questions">
      <div className={cn(CONTAINER, "grid gap-14 lg:grid-cols-[0.8fr_1.2fr]")}>
        <SectionHeading
          className="lg:sticky lg:top-28 lg:self-start"
          title="Questions, answered"
        />
        <div className="divide-y divide-border border-border border-y">
          {QUESTIONS.map((item) => (
            <details className="group py-6" key={item.q}>
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-sm font-medium text-lg outline-none focus-visible:ring-3 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                {item.q}
                <CaretDownIcon
                  aria-hidden
                  className="size-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
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
      <div className={cn(CONTAINER, "flex flex-col items-center text-center")}>
        <h2 className="max-w-2xl text-balance font-semibold text-4xl tracking-tight sm:text-5xl">
          Give every enquiry the answer it deserves.
        </h2>
        <p className="mt-4 max-w-xl text-lg text-muted-foreground leading-relaxed">
          Set up in minutes. Nothing goes live until you approve it.
        </p>
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          {actions}
        </div>
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
  Features,
  Hero,
  SiteFooter,
  SiteHeader,
  Steps,
}
