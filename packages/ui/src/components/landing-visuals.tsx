import {
  ArrowsClockwiseIcon,
  ArrowUpIcon,
  ChatCircleIcon,
  CheckCircleIcon,
  CodeIcon,
  EnvelopeSimpleIcon,
  GlobeSimpleIcon,
  type Icon,
  LockSimpleIcon,
  NotePencilIcon,
  ReceiptIcon,
  UsersIcon,
} from "@phosphor-icons/react"
import { buttonVariants } from "@workspace/ui/components/button"
import { PersonaAvatar, PersonaStage } from "@workspace/ui/components/persona"
import { cn } from "@workspace/ui/lib/utils"
import type { ReactNode } from "react"

/**
 * The front page's pictures: Reme itself, and Reme's own screens drawn in
 * markup so they stay sharp, follow the theme and cost no image bytes.
 *
 * Every screen is an illustration of a made-up business, Oakfield Cleaning,
 * not a screenshot of anyone's account. The controls are spans and the drawing
 * is hidden from assistive technology; a caption says what it shows instead.
 */

/**
 * The flat ground every illustration sits on, in the app's second neutral.
 * Without a caption it is decoration beside text that already says it all.
 */
function Frame({
  caption,
  className,
  children,
}: {
  caption?: string
  className?: string
  children: ReactNode
}) {
  const Tag = caption ? "figure" : "div"
  return (
    <Tag
      className={cn(
        "rounded-[1.75rem] bg-rail p-2 ring-1 ring-border sm:p-3",
        className
      )}
    >
      {caption ? <figcaption className="sr-only">{caption}</figcaption> : null}
      <div aria-hidden className="h-full">
        {children}
      </div>
    </Tag>
  )
}

const SURFACE =
  "rounded-[1.25rem] bg-background text-foreground shadow-sm ring-1 ring-border"

/** What a button looks like, without being one. */
function FakeButton({
  children,
  variant = "default",
}: {
  children: ReactNode
  variant?: "default" | "outline"
}) {
  return (
    <span className={buttonVariants({ size: "sm", variant })}>{children}</span>
  )
}

/** Reme's avatar and name, with a line under it and anything trailing after. */
function RemeLine({
  title = "Reme",
  detail,
  delay,
  className,
  children,
}: {
  title?: string
  detail: string
  delay?: number
  className?: string
  children?: ReactNode
}) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <PersonaAvatar delay={delay} />
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-sm">{title}</span>
        <span className="block text-muted-foreground text-xs">{detail}</span>
      </span>
      {children}
    </div>
  )
}

type Note = { icon: Icon; title: string; detail: string }

/** Seconds each note holds its spot; the loop is this times the note count. */
const NOTE_TURN = 3

/**
 * Notes sharing one spot beside the persona, taking turns, each fading out as
 * the next fades in. `delay` staggers spots so only one changes at a time.
 * With motion off, the first note stays and the rest never show.
 */
function NoteSpot({
  notes,
  delay,
  align = "left",
  className,
}: {
  notes: Note[]
  delay: number
  /** Which edge the notes line up on, so a long one grows away from Reme. */
  align?: "left" | "right"
  className: string
}) {
  return (
    <div className={cn("absolute", className)}>
      {notes.map((note, index) => (
        <span
          className={cn(
            "flex w-max items-center gap-2.5 rounded-xl bg-background/95 py-2 pr-3.5 pl-2 opacity-0 shadow-lg ring-1 ring-border backdrop-blur [animation-fill-mode:both] motion-safe:animate-note-cycle",
            index === 0
              ? "motion-reduce:opacity-100"
              : cn(
                  "absolute top-0 motion-reduce:hidden",
                  align === "left" ? "left-0" : "right-0"
                )
          )}
          key={note.title}
          style={{
            animationDelay: `${delay + index * NOTE_TURN}s`,
            animationDuration: `${notes.length * NOTE_TURN}s`,
          }}
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary sm:size-8">
            <note.icon className="size-4" />
          </span>
          <span className="whitespace-nowrap">
            <span className="block font-medium text-xs sm:text-sm">
              {note.title}
            </span>
            <span className="hidden text-muted-foreground text-xs sm:block">
              {note.detail}
            </span>
          </span>
        </span>
      ))}
    </div>
  )
}

/**
 * The hero's picture: Reme on its stage, with its work turning up around it.
 * The two spots sit on the disc's edge in the clear bands above the head and
 * below the body; the hello from `greet` takes the top right.
 */
function HeroStage({ className }: { className?: string }) {
  return (
    <figure className={cn("relative mx-auto w-full max-w-lg", className)}>
      <figcaption className="sr-only">
        Reme, a friendly assistant in a headset, with notes of its work
        appearing around it: replies, new leads, follow-ups, quotes and website
        changes waiting for approval.
      </figcaption>
      <PersonaStage greet>
        <NoteSpot
          className="top-[3%] left-[2%] sm:left-0"
          delay={0.6}
          notes={[
            {
              icon: ChatCircleIcon,
              title: "Replied to Sarah",
              detail: "11:42 pm, deep clean enquiry",
            },
            {
              icon: NotePencilIcon,
              title: "New lead logged",
              detail: "Office clean, from your quote form",
            },
            {
              icon: ArrowsClockwiseIcon,
              title: "Followed up Sam",
              detail: "No reply since Monday",
            },
          ]}
        />
        <NoteSpot
          align="right"
          className="right-[2%] bottom-[3%] sm:right-0"
          delay={2.1}
          notes={[
            {
              icon: ReceiptIcon,
              title: "Quote ready, £210",
              detail: "From your price list",
            },
            {
              icon: CheckCircleIcon,
              title: "Quote sent",
              detail: "Approved by you at 8:05 am",
            },
            {
              icon: GlobeSimpleIcon,
              title: "Website change ready",
              detail: "Waiting for your approval",
            },
          ]}
        />
      </PersonaStage>
    </figure>
  )
}

const CHANNELS: { icon: Icon; label: string }[] = [
  { icon: GlobeSimpleIcon, label: "Website chat" },
  { icon: NotePencilIcon, label: "Quote form" },
  { icon: EnvelopeSimpleIcon, label: "Email" },
]

const STAFF: { icon: Icon; title: string; detail: string }[] = [
  {
    icon: UsersIcon,
    title: "Client Services",
    detail: "Every lead, followed through",
  },
  { icon: CodeIcon, title: "Developer", detail: "Your website, taken care of" },
]

/** Curves meeting in the middle, drawn to stretch with the grid. */
function Connector({ branches }: { branches: number[] }) {
  return (
    <svg
      aria-hidden
      className="h-full w-full overflow-visible text-border"
      fill="none"
      preserveAspectRatio="none"
      viewBox="0 0 100 240"
    >
      {branches.map((y) => (
        <path
          d={`M0 ${y} C 60 ${y}, 40 120, 100 120`}
          key={y}
          stroke="currentColor"
          strokeWidth="1.25"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <path
        className="text-primary motion-safe:animate-flow"
        d="M0 120 H100"
        stroke="currentColor"
        strokeDasharray="4 6"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

/** Where work comes from, who takes it, and who does it. */
function FlowDiagram() {
  return (
    <figure>
      <figcaption className="sr-only">
        Enquiries from website chat, the quote form and email reach Reme, which
        hands the work to Client Services and the Developer.
      </figcaption>
      <div
        aria-hidden
        className="grid items-center gap-8 md:grid-cols-[1fr_5rem_auto_5rem_1.3fr] md:gap-0"
      >
        <ul className="flex flex-col gap-3 md:h-60 md:justify-between md:py-[22px]">
          {CHANNELS.map((channel) => (
            <li className="flex items-center gap-3 text-sm" key={channel.label}>
              <span className="grid size-9 place-items-center rounded-md bg-background ring-1 ring-border">
                <channel.icon className="size-4.5 text-muted-foreground" />
              </span>
              {channel.label}
            </li>
          ))}
        </ul>
        {/* Each connector's box starts and ends on the centres of the rows
            it joins, so the curves land on them at any width. */}
        <div className="hidden h-60 py-10 md:block">
          <Connector branches={[0, 120, 240]} />
        </div>
        <div className="relative flex flex-col items-center px-6 text-center md:block">
          <PersonaAvatar className="size-20 rounded-2xl" />
          <div className="mt-4 md:absolute md:top-full md:left-1/2 md:-translate-x-1/2 md:whitespace-nowrap">
            <p className="font-medium">Reme</p>
            <p className="text-muted-foreground text-sm">
              Your business assistant
            </p>
            <p className="mt-2 flex items-center gap-1.5 text-primary text-xs">
              <span className="relative flex size-1.5">
                <span className="absolute inset-0 rounded-full bg-primary motion-safe:animate-ping" />
                <span className="relative size-1.5 rounded-full bg-primary" />
              </span>
              Ready to work
            </p>
          </div>
        </div>
        <div className="hidden h-60 py-[34px] md:block">
          <Connector branches={[0, 240]} />
        </div>
        <ul className="flex flex-col gap-3 md:h-60 md:justify-between">
          {STAFF.map((role) => (
            <li
              className="flex items-center gap-3 rounded-lg bg-background p-4 ring-1 ring-border"
              key={role.title}
            >
              <role.icon className="size-4.5 text-primary" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-sm">{role.title}</span>
                <span className="block text-muted-foreground text-xs">
                  {role.detail}
                </span>
              </span>
              <CheckCircleIcon className="size-4 text-primary" />
            </li>
          ))}
        </ul>
      </div>
    </figure>
  )
}

const OVERNIGHT: { icon: Icon; title: string; detail: string; time: string }[] =
  [
    {
      icon: ChatCircleIcon,
      title: "Answered Sarah Shah",
      detail: "Deep clean, three-bed semi, Saturday",
      time: "11:42 pm",
    },
    {
      icon: NotePencilIcon,
      title: "Logged a new lead",
      detail: "Weekly office clean, from your quote form",
      time: "6:15 am",
    },
    {
      icon: ArrowsClockwiseIcon,
      title: "Followed up Sam Patel",
      detail: "Quote sent Monday, no reply yet",
      time: "8:00 am",
    },
  ]

/** The owner's morning with Reme: what was handled, and the one call left. */
function ProductWindow({ className }: { className?: string }) {
  return (
    <Frame
      caption="An example of the owner's morning in Reme: three enquiries handled overnight and one quote waiting for approval."
      className={className}
    >
      <div className={cn(SURFACE, "flex flex-col overflow-hidden text-left")}>
        <RemeLine
          className="border-border border-b px-5 py-3"
          delay={1.5}
          detail="3 handled overnight"
        />
        <div className="flex flex-col gap-3.5 px-4 py-5 text-chat sm:px-6">
          <p className="max-w-[88%] self-start rounded-3xl bg-muted px-4 py-2.5">
            Morning, Jo. Three enquiries came in overnight. I've answered all
            three, and one needs you.
          </p>
          <ul className="flex flex-col divide-y divide-border rounded-2xl ring-1 ring-border">
            {OVERNIGHT.map((item) => (
              <li
                className="flex items-center gap-3 px-4 py-3"
                key={item.title}
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                  <item.icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-sm">
                    {item.title}
                  </span>
                  <span className="block truncate text-muted-foreground text-xs">
                    {item.detail}
                  </span>
                </span>
                <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                  {item.time}
                </span>
              </li>
            ))}
          </ul>
          <div className="rounded-2xl bg-muted p-4">
            <div className="flex items-start justify-between gap-4">
              <span>
                <span className="block font-medium text-sm">
                  Quote waiting for you
                </span>
                <span className="block text-muted-foreground text-xs">
                  End of tenancy, two-bed flat, Sunday
                </span>
              </span>
              <span className="font-semibold text-xl tabular-nums tracking-tight">
                £240
              </span>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <span className="text-muted-foreground text-xs">
                Sunday is outside your usual hours.
              </span>
              <span className="flex gap-2">
                <FakeButton variant="outline">Edit</FakeButton>
                <FakeButton>Approve</FakeButton>
              </span>
            </div>
          </div>
        </div>
        <div className="mx-4 mb-4 flex h-11 items-center gap-3 rounded-full bg-muted pr-1.5 pl-4 sm:mx-6">
          <span className="text-chat text-muted-foreground">Message Reme</span>
          <span className="ml-auto grid size-8 place-items-center rounded-full bg-foreground text-background">
            <ArrowUpIcon className="size-4" />
          </span>
        </div>
      </div>
    </Frame>
  )
}

const WIDGET: { from: "customer" | "reme"; text: string }[] = [
  {
    from: "customer",
    text: "Hi, how much is a deep clean for a three-bed semi? Saturday if possible.",
  },
  {
    from: "reme",
    text: "Hi Sarah, thanks for getting in touch. A deep clean for a three-bed usually takes about five hours. Do you have pets, and would you like the oven done?",
  },
  { from: "customer", text: "One cat. Yes please, oven too." },
  {
    from: "reme",
    text: "That's everything Jo needs. She'll send your quote for Saturday directly.",
  },
]

/** The chat on the owner's website, answering a customer late at night. */
function ChatWidget() {
  return (
    <Frame caption="An example website chat: Reme answers a customer's deep clean enquiry for Oakfield Cleaning at 11:42 pm and gathers the details for a quote.">
      <div className={cn(SURFACE, "mx-auto flex max-w-md flex-col")}>
        <RemeLine
          className="border-border border-b px-5 py-4"
          delay={0.8}
          detail="Oakfield Cleaning"
        >
          <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <span className="size-1.5 rounded-full bg-primary" />
            Online
          </span>
        </RemeLine>
        <div className="flex flex-col gap-3 px-5 py-5 text-chat">
          <p className="text-center text-muted-foreground text-xs">11:42 pm</p>
          {WIDGET.map((message) => (
            <p
              className={cn(
                "max-w-[85%] rounded-3xl px-4 py-2.5",
                message.from === "customer"
                  ? "self-end bg-primary text-primary-foreground"
                  : "self-start bg-muted"
              )}
              key={message.text}
            >
              {message.text}
            </p>
          ))}
        </div>
        <div className="mx-4 mb-4 flex h-11 items-center rounded-full bg-muted px-4 text-chat text-muted-foreground">
          Type a message
        </div>
      </div>
    </Frame>
  )
}

/** Setup as it happens: one question, the answers, one detail saved. */
function OnboardingChat() {
  return (
    <Frame caption="An example of setup: Reme asks which services to handle enquiries for, the owner picks two, and the answer is added to the business profile.">
      <div className={cn(SURFACE, "p-6")}>
        <RemeLine delay={2.2} detail="Getting to know your business" />
        <p className="mt-6 text-chat">
          Let's start with the work you do. Which services should I handle
          enquiries for?
        </p>
        <div className="mt-4 flex flex-col gap-2">
          {["Regular home cleaning", "End of tenancy", "Office cleaning"].map(
            (option, index) => (
              <span
                className={cn(
                  "flex items-center justify-between rounded-lg border px-4 py-2.5 text-sm",
                  index < 2
                    ? "border-primary/50 bg-primary/8"
                    : "border-foreground/20 border-dashed text-muted-foreground"
                )}
                key={option}
              >
                {option}
                {index < 2 ? (
                  <CheckCircleIcon className="size-4 text-primary" />
                ) : null}
              </span>
            )
          )}
        </div>
        <p className="mt-5 flex items-center gap-2 text-primary text-sm">
          <CheckCircleIcon className="size-4" />
          Added to your business profile
        </p>
        <div className="mt-5 flex gap-5 border-border border-t pt-4 text-muted-foreground text-sm">
          <span className="text-foreground">Services</span>
          <span>Service area</span>
          <span>Pricing</span>
          <span className="hidden sm:inline">Policies</span>
        </div>
      </div>
    </Frame>
  )
}

const REQUEST: [string, string][] = [
  ["Date", "Saturday 14 Nov"],
  ["Property", "3 bed, 2 bath"],
  ["Extras", "Oven, inside fridge"],
  ["Pets", "One cat"],
  ["Access", "Key with neighbour"],
  ["Postcode", "LS6"],
]

/** A quote request as it reaches the owner: complete, with a price to check. */
function QuoteRequest() {
  return (
    <Frame
      caption="An example quote request: the job details Reme gathered, a price suggested from the owner's price list, and buttons to edit or send it."
      className="h-full"
    >
      <div className={cn(SURFACE, "h-full p-6")}>
        <p className="text-muted-foreground text-xs">
          Quote request from Sarah Shah, website chat
        </p>
        <p className="mt-1 font-medium text-lg tracking-tight">
          Deep clean, three-bed semi
        </p>
        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4">
          {REQUEST.map(([term, detail]) => (
            <div key={term}>
              <dt className="text-muted-foreground text-xs">{term}</dt>
              <dd className="mt-0.5 text-sm">{detail}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-6 flex items-end justify-between gap-4 border-border border-t pt-5">
          <span>
            <span className="block text-muted-foreground text-xs">
              From your price list
            </span>
            <span className="block font-medium text-3xl tabular-nums tracking-tight">
              £210
            </span>
          </span>
          <span className="flex gap-2">
            <FakeButton variant="outline">Edit</FakeButton>
            <FakeButton>Send quote</FakeButton>
          </span>
        </div>
      </div>
    </Frame>
  )
}

const HISTORY: { when: string; text: string }[] = [
  { when: "Mon 9:14 am", text: "Enquiry from your quote form" },
  { when: "Mon 9:16 am", text: "Replied and asked about extras" },
  { when: "Tue 10:02 am", text: "Quote sent for £210, approved by you" },
  { when: "Thu 9:00 am", text: "Followed up: still keen on Saturday?" },
  { when: "Thu 11:20 am", text: "Booked for Saturday 14 Nov" },
]

/** One lead from first message to booking, with the nudge that won it. */
function LeadHistory() {
  return (
    <Frame
      caption="An example lead history: an enquiry on Monday, a quote on Tuesday, a follow-up on Thursday morning and a booking the same day."
      className="h-full"
    >
      <div className={cn(SURFACE, "h-full p-6")}>
        <div className="flex items-start justify-between gap-4">
          <span>
            <span className="block font-medium text-lg tracking-tight">
              Sarah Shah
            </span>
            <span className="block text-muted-foreground text-xs">
              Deep clean, £210
            </span>
          </span>
          <span className="rounded-full bg-primary/12 px-2.5 py-1 font-medium text-primary text-xs">
            Booked
          </span>
        </div>
        <ol className="mt-6 flex flex-col gap-4 border-border border-l pl-6">
          {HISTORY.map((step, index) => (
            <li className="relative" key={step.when}>
              <span
                className={cn(
                  "absolute top-1.5 -left-[1.8rem] size-2.5 rounded-full ring-4 ring-background",
                  index === HISTORY.length - 1
                    ? "bg-primary"
                    : "bg-foreground/25"
                )}
              />
              <span className="block text-muted-foreground text-xs tabular-nums">
                {step.when}
              </span>
              <span className="block text-sm">{step.text}</span>
            </li>
          ))}
        </ol>
      </div>
    </Frame>
  )
}

const SERVICES: [string, string][] = [
  ["Regular clean", "From £18 an hour"],
  ["Deep clean", "From £180"],
  ["End of tenancy", "From £220"],
]

/** The site Reme builds, in a browser, with Reme answering on it. */
function WebsitePreview() {
  return (
    <Frame caption="An example website Reme built for a cleaning business on a remeai.co.uk address, on Google Search Console, with Reme ready to answer enquiries on it.">
      <div className={cn(SURFACE, "overflow-hidden")}>
        <div className="flex h-11 items-center gap-2 border-border border-b bg-muted/50 px-4">
          <span className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-foreground/15" />
            <span className="size-2.5 rounded-full bg-foreground/15" />
            <span className="size-2.5 rounded-full bg-foreground/15" />
          </span>
          <span className="mx-auto flex items-center gap-1.5 rounded-md bg-background px-3 py-1 text-muted-foreground text-xs ring-1 ring-border">
            <LockSimpleIcon className="size-3" />
            oakfield.remeai.co.uk
          </span>
          <GlobeSimpleIcon className="size-4 text-muted-foreground" />
        </div>
        <div className="px-6 pt-5 pb-6 sm:px-8">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">Oakfield Cleaning</span>
            <span className="hidden gap-5 text-muted-foreground text-xs sm:flex">
              <span>Services</span>
              <span>Areas</span>
              <span>Contact</span>
            </span>
          </div>
          <p className="mt-9 max-w-xs text-balance font-medium text-3xl leading-tight tracking-tight">
            Spotless homes across Leeds.
          </p>
          <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
            {["Insured and vetted", "Your service area", "Same-week slots"].map(
              (point) => (
                <span className="flex items-center gap-1.5" key={point}>
                  <CheckCircleIcon className="size-3 text-primary" />
                  {point}
                </span>
              )
            )}
          </p>
          <span className="mt-5 inline-flex">
            <FakeButton>Get a quote</FakeButton>
          </span>
          <div className="mt-7 grid grid-cols-3 gap-2.5">
            {SERVICES.map(([name, price]) => (
              <span className="rounded-lg bg-muted p-3" key={name}>
                <span className="block font-medium text-xs sm:text-sm">
                  {name}
                </span>
                <span className="block text-muted-foreground text-xs">
                  {price}
                </span>
              </span>
            ))}
          </div>
          <RemeLine
            className="mt-6 flex-wrap border-border border-t pt-5"
            delay={3}
            detail="Ready for the next enquiry."
            title="Reme is here."
          >
            <span className="flex items-center gap-1.5 rounded-full bg-primary/12 px-2.5 py-1 text-primary text-xs">
              <CheckCircleIcon className="size-3.5" />
              On Google Search Console
            </span>
          </RemeLine>
        </div>
      </div>
    </Frame>
  )
}

export {
  ChatWidget,
  FlowDiagram,
  Frame,
  HeroStage,
  LeadHistory,
  OnboardingChat,
  ProductWindow,
  QuoteRequest,
  WebsitePreview,
}
