import {
  CaretDownIcon,
  ChatCircleIcon,
  CheckCircleIcon,
  ClipboardTextIcon,
  ClockIcon,
  FileTextIcon,
  HandIcon,
  type Icon,
  MagnifyingGlassIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
} from "@phosphor-icons/react"
import {
  ChatWidget,
  FlowDiagram,
  HeroStage,
  LeadHistory,
  OnboardingChat,
  ProductWindow,
  QuoteRequest,
  WebsitePreview,
} from "@workspace/ui/components/landing-visuals"
import { Persona } from "@workspace/ui/components/persona"
import { ThemeToggle } from "@workspace/ui/components/theme-toggle"
import { cn } from "@workspace/ui/lib/utils"
import type { ReactNode } from "react"

/**
 * Reme's own front page, as sections.
 *
 * Presentational only, and links come in as slots so this package imports no
 * router. Every claim on the page is one the product plan makes for the first
 * release: nothing here promises payments, SMS, WhatsApp or calendar sync,
 * which are later, and roles not yet built are labelled as coming. There is no
 * testimonial, customer count or price, because none of them exists yet and an
 * invented one would read as real.
 */

const CONTAINER = "mx-auto w-full max-w-6xl px-6"
const SECTION = "scroll-mt-16 border-border border-t py-24 sm:py-32"
const H2 =
  "text-balance font-medium text-[2.125rem] leading-[1.12] tracking-[-0.025em] sm:text-[2.75rem]"
const LEAD = "text-lg text-muted-foreground leading-relaxed"

/** A rise into place on first paint; pair with a `delay-*` to stagger. */
const RISE =
  "fill-mode-both duration-700 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3"

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
      <div className={cn(CONTAINER, "flex h-16 items-center gap-6")}>
        {brand}
        <nav aria-label="On this page" className="mx-auto hidden md:block">
          <ul className="flex gap-7 text-muted-foreground text-sm">
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
        <div className="ml-auto flex items-center gap-2 md:ml-0">{actions}</div>
      </div>
    </header>
  )
}

/** Two lines, the second quieter: the statement, then what it means. */
function Heading({
  kicker,
  first,
  second,
  className,
  children,
}: {
  kicker: string
  first: string
  second?: string
  className?: string
  children?: ReactNode
}) {
  return (
    <div className={cn("reveal max-w-2xl", className)}>
      <p className="font-medium text-primary text-sm">{kicker}</p>
      <h2 className={cn(H2, "mt-4")}>
        {first}
        {second ? (
          <>
            <br />
            <span className="text-muted-foreground">{second}</span>
          </>
        ) : null}
      </h2>
      {children ? <p className={cn(LEAD, "mt-5")}>{children}</p> : null}
    </div>
  )
}

/** A heading beside its picture, the picture first on wide screens if flipped. */
function Split({
  heading,
  visual,
  flip = false,
}: {
  heading: ReactNode
  visual: ReactNode
  flip?: boolean
}) {
  return (
    <div className="grid items-center gap-14 lg:grid-cols-2 lg:gap-20">
      {heading}
      <div className={cn("reveal", flip && "lg:order-first")}>{visual}</div>
    </div>
  )
}

/**
 * The first screen: it fills the window under the header, so the strip of what
 * Reme does sits on the bottom edge of the view rather than halfway down it.
 */
function Hero({ actions }: { actions: ReactNode }) {
  return (
    <section className="flex min-h-[calc(100svh-4rem)] flex-col overflow-hidden">
      <div
        className={cn(
          CONTAINER,
          "grid flex-1 items-center gap-10 py-12 sm:py-16 lg:grid-cols-[1.05fr_0.95fr] lg:gap-6 [@media(max-height:820px)]:lg:py-8"
        )}
      >
        <div className="text-center lg:text-left">
          <p
            className={cn(
              RISE,
              "inline-flex items-center gap-2 rounded-full px-3 py-1 text-muted-foreground text-xs ring-1 ring-border"
            )}
          >
            <span className="size-1.5 rounded-full bg-primary" />
            Made for cleaning businesses
          </p>
          <h1
            className={cn(
              RISE,
              "mt-6 text-balance font-medium text-5xl leading-[1.06] tracking-[-0.03em] delay-100 sm:text-6xl lg:text-[4.25rem]"
            )}
          >
            Meet Reme,
            <br />
            <span className="text-muted-foreground">
              your business assistant.
            </span>
          </h1>
          <p
            className={cn(
              RISE,
              LEAD,
              "mx-auto mt-6 max-w-xl delay-200 lg:mx-0"
            )}
          >
            Reme answers every enquiry in your voice, gathers what each quote
            needs and follows up until the customer decides. Routine work runs
            itself. The decisions stay yours.
          </p>
          <div
            className={cn(
              RISE,
              "mt-9 flex flex-wrap justify-center gap-3 delay-300 lg:justify-start"
            )}
          >
            {actions}
          </div>
          <p
            className={cn(RISE, "mt-5 text-muted-foreground text-xs delay-500")}
          >
            Set up in one conversation. Nothing goes live until you approve it.
          </p>
        </div>
        <HeroStage className="[@media(max-height:820px)]:lg:max-w-md" />
      </div>
      <Abilities />
    </section>
  )
}

const ABILITIES: { icon: Icon; label: string }[] = [
  { icon: ChatCircleIcon, label: "Responds to enquiries" },
  { icon: FileTextIcon, label: "Prepares quotes" },
  { icon: ClockIcon, label: "Follows through" },
  { icon: ShieldCheckIcon, label: "Keeps you in control" },
]

/** What Reme does, in a few words each, along the hero's bottom edge. */
function Abilities() {
  return (
    <div className="border-border border-t">
      <ul
        aria-label="What Reme does"
        className={cn(
          CONTAINER,
          "grid grid-cols-2 gap-x-6 gap-y-4 py-5 text-muted-foreground text-sm sm:flex sm:justify-center sm:gap-10"
        )}
      >
        {ABILITIES.map((item) => (
          <li className="flex items-center gap-2" key={item.label}>
            <item.icon aria-hidden className="size-4" />
            {item.label}
          </li>
        ))}
      </ul>
    </div>
  )
}

const POINTS: { icon: Icon; title: string; text: string }[] = [
  {
    icon: ChatCircleIcon,
    title: "An assistant, not another inbox.",
    text: "Talk to Reme in plain language. It knows the business, hands work to the right place and brings the outcome back to you.",
  },
  {
    icon: ClipboardTextIcon,
    title: "The next step is part of the job.",
    text: "Every lead has a stage and a follow-up date. Quotes and bookings stay connected instead of scattered across threads.",
  },
  {
    icon: ShieldCheckIcon,
    title: "Only the decisions that need you.",
    text: "Routine work moves within your rules. Discounts, exceptions and anything unusual come to you with the context to decide.",
  },
]

/** The promise in one section: what Reme takes off the owner's plate. */
function Assistant() {
  return (
    <section className={SECTION} id="assistant">
      <div className={CONTAINER}>
        <Heading
          first="You run the business."
          kicker="Less chasing. More doing."
          second="Reme carries the work forward."
        >
          An enquiry shouldn't become another thing to remember. Reme answers,
          gathers the right details, prepares the quote and follows up, so
          opportunities don't disappear between conversations.
        </Heading>
        <div className="mt-16 grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <ul className="reveal flex flex-col gap-9">
            {POINTS.map((point) => (
              <li className="flex gap-4" key={point.title}>
                <point.icon
                  aria-hidden
                  className="mt-0.5 size-5 shrink-0 text-primary"
                />
                <div>
                  <h3 className="font-medium">{point.title}</h3>
                  <p className="mt-1.5 text-muted-foreground leading-relaxed">
                    {point.text}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          <ProductWindow className="reveal" />
        </div>
      </div>
    </section>
  )
}

const ROLES: {
  icon: Icon
  title: string
  text: string
  status: "now" | "next" | "planned"
}[] = [
  {
    icon: ChatCircleIcon,
    title: "Client Services",
    text: "First replies, qualification, quotes, follow-ups and booking conversations across your customer channels.",
    status: "now",
  },
  {
    icon: FileTextIcon,
    title: "Developer",
    text: "Builds and maintains your website from your confirmed details. You review it before it publishes.",
    status: "now",
  },
  {
    icon: ClockIcon,
    title: "Booking Coordinator",
    text: "Calendar and crew coordination, reminders and service-day messages.",
    status: "next",
  },
  {
    icon: MagnifyingGlassIcon,
    title: "Growth",
    text: "Listings, search content, lead research and outreach you approve.",
    status: "next",
  },
  {
    icon: SlidersHorizontalIcon,
    title: "Ops Manager",
    text: "Internal tasks and the day-to-day follow-through behind each job.",
    status: "planned",
  },
  {
    icon: ClipboardTextIcon,
    title: "QA Coordinator",
    text: "Quality checks, post-service follow-up and review requests.",
    status: "planned",
  },
]

const STATUS = {
  now: "Available now",
  next: "Coming next",
  planned: "Planned",
} as const

/** One contact, a team behind it, and the roadmap shown as the org chart. */
function Workforce() {
  return (
    <section className={SECTION} id="workforce">
      <div className={CONTAINER}>
        <Heading
          first="One point of contact."
          kicker="A team, not a collection of tools"
          second="The right specialist for the job."
        >
          You talk to Reme. Reme hands each piece of work to the specialist
          built for it, checks the result and reports back. Rename a role, pause
          it, or add another as you grow.
        </Heading>
        <div className="reveal mt-16 rounded-2xl bg-rail p-6 ring-1 ring-border sm:p-10">
          <FlowDiagram />
        </div>
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ROLES.map((role) => (
            <li
              className={cn(
                "reveal rounded-xl p-6",
                role.status === "now"
                  ? "bg-card ring-1 ring-border"
                  : "border border-border border-dashed"
              )}
              key={role.title}
            >
              <div className="flex items-center justify-between">
                <span
                  className={cn(
                    "grid size-9 place-items-center rounded-md",
                    role.status === "now"
                      ? "bg-primary/12 text-primary"
                      : "text-muted-foreground"
                  )}
                >
                  <role.icon aria-hidden className="size-4.5" />
                </span>
                <span
                  className={cn(
                    "text-xs",
                    role.status === "now"
                      ? "text-primary"
                      : "text-muted-foreground"
                  )}
                >
                  {STATUS[role.status]}
                </span>
              </div>
              <h3 className="mt-5 font-medium text-lg">{role.title}</h3>
              <p className="mt-2 text-muted-foreground text-sm leading-relaxed">
                {role.text}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

/** Late-night enquiries, the moment most jobs are won or lost. */
function Enquiries() {
  return (
    <section className={SECTION} id="enquiries">
      <div className={CONTAINER}>
        <Split
          heading={
            <Heading
              first="Answers like you would,"
              kicker="Day and night"
              second="even at 11 pm."
            >
              Enquiries from your website chat, quote form and email land in one
              place. Reme replies from the services, prices and hours you've
              confirmed, and asks the questions you'd ask.
            </Heading>
          }
          visual={<ChatWidget />}
        />
      </div>
    </section>
  )
}

const PILLARS = [
  {
    title: "Facts, not guesswork.",
    text: "What you tell Reme becomes a business profile you can review and edit at any time.",
  },
  {
    title: "One connected pipeline.",
    text: "Website chat, forms and email all feed the same customer journey.",
  },
  {
    title: "Better with your guidance.",
    text: "Corrections shape the next reply. Your rules change only with your approval.",
  },
] as const

/** Setup as a conversation, and what it leaves behind. */
function Setup() {
  return (
    <section className={SECTION} id="how">
      <div className={CONTAINER}>
        <Split
          heading={
            <Heading
              first="It starts with"
              kicker="Built around your business"
              second="a conversation."
            >
              No blank settings screen. Reme gets to know your services, prices,
              service area and policies, asking for what's missing one question
              at a time.
            </Heading>
          }
          visual={<OnboardingChat />}
        />
        <ol className="mt-20 grid gap-10 border-border border-t pt-12 md:grid-cols-3">
          {PILLARS.map((pillar, index) => (
            <li className="reveal" key={pillar.title}>
              <span className="font-medium text-primary text-sm tabular-nums">
                0{index + 1}
              </span>
              <h3 className="mt-3 font-medium">{pillar.title}</h3>
              <p className="mt-1.5 text-muted-foreground leading-relaxed">
                {pillar.text}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}

/** Quotes and follow-ups side by side: the two places money leaks. */
function Pipeline() {
  return (
    <section className={SECTION} id="quotes">
      <div className={CONTAINER}>
        <Heading
          className="mx-auto text-center"
          first="Quotes that arrive ready."
          kicker="From enquiry to booked"
          second="Follow-ups that never slip."
        >
          Every request reaches you with the job details gathered and a price
          from your own list. Then Reme keeps the lead moving until it books.
        </Heading>
        <div className="mt-16 grid gap-6 lg:grid-cols-2">
          <div className="reveal">
            <QuoteRequest />
          </div>
          <div className="reveal">
            <LeadHistory />
          </div>
        </div>
      </div>
    </section>
  )
}

/** The website, built and kept up from the same facts Reme answers from. */
function Website() {
  return (
    <section className={SECTION} id="website">
      <div className={CONTAINER}>
        <Split
          flip
          heading={
            <Heading
              first="A website that doesn't"
              kicker="Your front door, taken care of"
              second="stop at looking good."
            >
              Reme builds your site from the details you've confirmed and puts
              it on Google Search Console. Its chat and quote form lead straight
              back to Reme, so a first visit becomes a conversation. Start on a
              remeai.co.uk address or bring your own domain.
            </Heading>
          }
          visual={<WebsitePreview />}
        />
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
    <div className="reveal rounded-xl bg-background/50 p-7 ring-1 ring-border">
      <h3 className="font-medium">{title}</h3>
      <ul className="mt-5 flex flex-col gap-3.5 text-sm">
        {items.map((item) => (
          <li className="flex gap-3 leading-relaxed" key={item}>
            <ItemIcon
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-primary"
            />
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The one dark band on the page. It takes the dark theme's tokens whatever the
 * page is in, so it stays dark in light mode and lifts to the card colour in
 * dark mode.
 */
function Control() {
  return (
    <section
      className="dark scroll-mt-16 bg-card py-24 text-card-foreground sm:py-32"
      id="control"
    >
      <div className={cn(CONTAINER, "grid gap-14 lg:grid-cols-[0.9fr_1.1fr]")}>
        <Heading
          first="Capable by default."
          kicker="Designed to earn your trust"
          second="Accountable to you."
        >
          You decide where the line sits, and Reme holds it. Customers, emails
          and web pages can give it information, never instructions.
        </Heading>
        <div className="grid gap-4 sm:grid-cols-2">
          <ControlList
            icon={CheckCircleIcon}
            items={ON_ITS_OWN}
            title="Handled for you"
          />
          <ControlList
            icon={HandIcon}
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
    a: "No. Reme builds one for you on a remeai.co.uk address, and moves it to your own domain when you're ready.",
  },
  {
    q: "Will it message my customers without asking me?",
    a: "It answers questions, collects details and sends follow-ups on its own. Quotes outside your rules, bookings and changes to your website wait for your approval.",
  },
  {
    q: "Does it pretend to be a person?",
    a: "No. Reme never claims to be human, says when it doesn't know something, and never says an action worked before it has.",
  },
  {
    q: "How long does setup take?",
    a: "Most owners finish in one sitting. Reme asks only what it can't work out itself, and everything you tell it can be reviewed and edited later.",
  },
  {
    q: "What if a customer tries to talk it round?",
    a: "Your rules are enforced by the system, not by persuasion, so asking twice doesn't change the answer.",
  },
] as const

/** Native disclosure, so it works before hydration and needs no script. */
function Faq() {
  return (
    <section className={SECTION} id="questions">
      <div className={cn(CONTAINER, "grid gap-14 lg:grid-cols-[0.8fr_1.2fr]")}>
        <Heading
          className="lg:sticky lg:top-28 lg:self-start"
          first="Questions,"
          kicker="Good to know"
          second="answered."
        />
        <div className="reveal divide-y divide-border border-border border-y">
          {QUESTIONS.map((item) => (
            <details className="group py-5" key={item.q}>
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                {item.q}
                <CaretDownIcon
                  aria-hidden
                  className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180"
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
      <div
        className={cn(
          CONTAINER,
          "reveal flex flex-col items-center text-center"
        )}
      >
        <Persona className="size-36" delay={1} framing="full" />
        <p className="mt-6 font-medium text-primary text-sm">
          Meet your new assistant
        </p>
        <h2 className={cn(H2, "mt-4 max-w-2xl sm:text-5xl")}>
          A little less on your plate.
          <br />
          <span className="text-muted-foreground">
            A lot more moving forward.
          </span>
        </h2>
        <p className={cn(LEAD, "mt-5 max-w-xl")}>
          Set up in one conversation. Nothing goes live until you approve it.
        </p>
        <div className="mt-9 flex flex-wrap justify-center gap-3">
          {actions}
        </div>
      </div>
    </section>
  )
}

type FooterColumn = { title: string; links: ReactNode }

/**
 * The page's foot: what Reme is, the ways around, and who makes it. Links come
 * in as slots per column, like the header, so this package imports no router.
 */
function SiteFooter({
  brand,
  columns,
}: {
  brand: ReactNode
  columns: FooterColumn[]
}) {
  return (
    <footer className="border-border border-t">
      <div className={cn(CONTAINER, "py-16")}>
        <div className="grid gap-12 md:grid-cols-[1.6fr_repeat(3,1fr)]">
          <div className="max-w-xs">
            {brand}
            <p className="mt-4 text-muted-foreground text-sm leading-relaxed">
              The business assistant for cleaning businesses. Answers enquiries,
              prepares quotes and follows up, with you in charge.
            </p>
          </div>
          {columns.map((column) => (
            <nav aria-label={column.title} key={column.title}>
              <h2 className="font-medium text-sm">{column.title}</h2>
              <div className="mt-4 flex flex-col items-start gap-3 text-muted-foreground text-sm [&_a:hover]:text-foreground [&_a]:transition-colors">
                {column.links}
              </div>
            </nav>
          ))}
        </div>
        <div className="mt-14 flex flex-col items-start gap-4 border-border border-t pt-8 text-muted-foreground text-xs sm:flex-row sm:items-center sm:gap-6">
          <p className="sm:mr-auto">
            © {new Date().getFullYear()} Jade &amp; Sterling Ltd. All rights
            reserved.
          </p>
          <p>
            Reme is made by{" "}
            <a
              className="text-foreground underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground"
              href="https://jadeandsterling.com/"
              rel="noopener"
            >
              Jade &amp; Sterling
            </a>
            . Operated from the United Kingdom.
          </p>
          <ThemeToggle />
        </div>
      </div>
    </footer>
  )
}

export {
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
}
