import {
  type ToolCallMessagePartComponent,
  useAui,
  useAuiState,
} from "@assistant-ui/react"
import { ArrowSquareOutIcon } from "@phosphor-icons/react"
import {
  BuyDomainInput,
  BuyDomainOutput,
  buyElsewhereLinks,
  type DomainPurchaseStatus,
  type DomainRegistrantPrefill,
  type DomainStemOffer,
  FindDomainInput,
  FindDomainOutput,
  needsRegistrantType,
  RegistrantDetails,
  type RegistrantField,
  type RegistrantType,
  RowEnding,
  toE164,
} from "@workspace/contracts"
import { Problem } from "@workspace/ui/components/assistant/decision"
import { useLaterDomainCard } from "@workspace/ui/components/assistant/domain"
import { PayDialog } from "@workspace/ui/components/assistant/pay-dialog"
import {
  Docked,
  TRAY_FIELD,
  TrayFrame,
  useTabDraft,
} from "@workspace/ui/components/assistant/question-tray"
import { Badge } from "@workspace/ui/components/badge"
import { markOf } from "@workspace/ui/components/brand-mark"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { Field } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { DoneIcon, ToolStatus } from "@workspace/ui/components/status-line"
import { pageAction, type ToolArgs } from "@workspace/ui/lib/activity-copy"
import { FIELD_ERROR, OPTION, OPTION_PILL } from "@workspace/ui/lib/card"
import { useLiveCards } from "@workspace/ui/lib/live-cards"
import { refusalText } from "@workspace/ui/lib/refusal"
import { type Failure, readView, stepOf } from "@workspace/ui/lib/tool-state"
import { cn, META } from "@workspace/ui/lib/utils"
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react"

/**
 * Choosing and buying a domain. `find_domain`'s rows show in the assistant's
 * message: up to six free names, the recommended one first and then every
 * .co.uk, each with its price in pounds and Choose. A chosen name offers
 * Buy from Cloudflare and GoDaddy, each opening its own search, and while
 * buying here is on (`buy_here`) Buy for its price, which docks Your details
 * in the question tray, prefilled from what the api holds and asking only
 * for the gaps; Pay opens the payment dialog on the purchase's Stripe
 * Checkout Session, where paying is the consent. I've bought it and Skip for
 * now are the owner's messages, so the assistant answers them in the chat.
 * `buy_domain` and a posted Pay button open Your details for their name. A
 * price shown is the api's, never the model's text: Reme's own from the
 * price table, or the registrar's from its check. Done, the thread keeps one
 * line.
 */

/** Where a paid purchase stands, in the card's words. */
export type PurchaseStatus =
  /** The hold is authorised and the registration is under way. */
  | "authorised"
  /** Registered; the website goes on it next. */
  | "serving"
  /** Registered and the website is on it. */
  | "registered"
  /** A test purchase: paid in test mode, registered in Cloudflare's sandbox. */
  | "test"
  /** Registration failed and the hold was released. */
  | "failed"
  /** The price rose past the ceiling before registering; nothing charged. */
  | "price_changed"
  /** Someone registered the name first; nothing charged. */
  | "unavailable"
  /** The Checkout expired before the owner paid. */
  | "abandoned"
  /** Registered, and later taken off the website. */
  | "removed"

/** A purchase as the api reads it, in the card's words; null while it waits on payment. */
export function purchaseStatusOf(
  read: DomainPurchaseStatus | null
): PurchaseStatus | null {
  if (!read) return null
  switch (read.outcome) {
    case "test_registered":
      return "test"
    case "payment_released":
      return "failed"
    case "price_changed":
      return "price_changed"
    case "unavailable":
      return "unavailable"
    case "expired":
      return "abandoned"
    case "registered":
      return read.state === "active"
        ? "registered"
        : read.state === "removed"
          ? "removed"
          : "serving"
    case undefined:
      break
  }
  switch (read.state) {
    case "awaiting_payment":
      return null
    case "failed":
      return "failed"
    case "abandoned":
      return "abandoned"
    case "removed":
      return "removed"
    case "active":
      return read.test ? "test" : "registered"
    case "awaiting_dns":
    case "verifying":
      return "authorised"
  }
}

/** What the dialog mounts Checkout with, or why it cannot. */
export type CheckoutStart =
  | { outcome: "open"; publishable_key: string; client_secret: string }
  | { outcome: "refused"; code: string | null }

/** A refusal the api gave, by its code. */
type Refused = { refused: string | null }

/** What the buy tray needs from the app. */
export type DomainPurchase = {
  /** The details page for a name, prefilled. */
  registrant: (name: string) => Promise<DomainRegistrantPrefill | Refused>
  /** Opens the purchase's Checkout with the details as shown. */
  checkout: (name: string, details: RegistrantDetails) => Promise<CheckoutStart>
  /** The newest purchase of that name, or null when there is none. */
  status: (name: string) => Promise<DomainPurchaseStatus | null>
  /** The owner buys it themselves, so the api watches the registry for it. */
  elsewhere: (name: string) => Promise<void>
}

const DomainPurchaseContext = createContext<DomainPurchase | null>(null)

/** Gives the buy tray the app's purchase calls. */
export const DomainPurchaseProvider = DomainPurchaseContext.Provider

const AGREEMENT = "https://www.cloudflare.com/domain-registration-agreement"
const ICANN = "https://www.icann.org/resources/pages/benefits-2013-09-16-en"

const pounds = (gbp: number) => `£${gbp}`

/**
 * Cloudflare's price, which it bills in dollars, in pounds to the nearest
 * pound and at least £1, or null without a fresh rate: never in dollars.
 */
export const registrarPrice = (usd: number, usdGbp?: number) =>
  usdGbp
    ? `About ${pounds(Math.max(1, Math.round(usd * usdGbp)))} a year`
    : null

/** One free full domain: its ending, Reme's yearly price and the registrar's, where known. */
type Offer = {
  name: string
  ending: RowEnding
  price?: number | undefined
  usd?: number | undefined
}

/** A row's free endings, in the order the owner reads them. */
const offersOf = (row: DomainStemOffer | undefined): Offer[] =>
  RowEnding.options.flatMap((ending) => {
    const at = row?.endings[ending]
    return at?.state === "free"
      ? [
          {
            name: `${row?.stem}.${ending}`,
            ending,
            price: at.price_gbp_year,
            usd: at.registrar_usd,
          },
        ]
      : []
  })

/** A link out, which says it opens a new tab. */
function Out({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      className="rounded-sm underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      {children}
      <ArrowSquareOutIcon aria-hidden className="ms-0.5 inline size-3" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}

/** What a tool that ended without a card has to say. */
function Line({ text }: { text: string }) {
  return <p className="px-1 py-1.5 text-muted-foreground text-sm">{text}</p>
}

/** A tool's line while it works, and when it failed or was stopped. */
function ToolLine({
  tool,
  args,
  state,
  streaming,
}: {
  tool: "find_domain" | "buy_domain"
  args: ToolArgs
  state: "working" | Failure
  streaming: boolean
}) {
  const working = state === "working" && streaming
  return (
    <ToolStatus
      args={args}
      className="flex px-1 py-1.5 text-sm"
      state={working ? "working" : state === "failed" ? "failed" : "stopped"}
      tool={tool}
    />
  )
}

/* Choose ------------------------------------------------------------------ */

/** The most names Choose offers. */
const SHORTLIST = 6

/** A name on Choose, with why it is offered when it is the recommended one. */
type Listed = Offer & { why?: string }

/**
 * The names Choose lists, at most six: the finder's best name first, as the
 * recommended one, then every free .co.uk, then the other endings, each in
 * the finder's order.
 */
export function shortlist(rows: readonly DomainStemOffer[]): Listed[] {
  const all = rows.flatMap(offersOf)
  const [best] = offersOf(rows[0])
  const rest = all.filter((offer) => offer.name !== best?.name)
  return [
    ...(best ? [{ ...best, why: rows[0]?.why }] : []),
    ...rest.filter((offer) => offer.ending === "co.uk"),
    ...rest.filter((offer) => offer.ending !== "co.uk"),
  ].slice(0, SHORTLIST)
}

/** Where the owner buys a name themselves, each opening its own search with the name filled in. */
const PROVIDERS = [
  { id: "cloudflare", name: "Cloudflare" },
  { id: "godaddy", name: "GoDaddy" },
] as const

/**
 * A name's sub line: Reme's own price while buying here is on; else
 * Cloudflare's in pounds, the only provider price there is data for, or
 * where to see it when there is no price in pounds to show.
 */
export function subLine(
  offer: Pick<Offer, "price" | "usd">,
  buyHere: boolean,
  usdGbp?: number
): string | null {
  if (buyHere) return offer.price ? `${pounds(offer.price)} a year` : null
  const price = offer.usd ? registrarPrice(offer.usd, usdGbp) : null
  return price ? `${price} at Cloudflare` : "Price shown at Cloudflare"
}

/** What the picker's Skip says as the owner, so the assistant answers in the chat. */
export const SKIP_DOMAIN = "I'll skip the domain for now"

/** Shown until the website is published. */
const PICKER_HINT =
  "You can do this before your site is published. I'll connect it for you."

/** How a chosen row's buttons come in. */
const ENTER =
  "motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 duration-enter ease-standard motion-safe:animate-in"

/**
 * One name: the name, a sub line with its price and provider, the
 * Recommended badge where it applies, and Choose. The whole row is the
 * Choose button. Chosen, Choose gives way to buying it: here while buying
 * here is on, and from each provider in a new tab.
 */
function PickerRow({
  offer,
  chosen,
  buyHere,
  usdGbp,
  onChoose,
  onFollow,
  onBuyHere,
}: {
  offer: Listed
  chosen: boolean
  buyHere: boolean
  usdGbp?: number | undefined
  onChoose: () => void
  onFollow: () => void
  onBuyHere: () => void
}) {
  const id = useId()
  const sub = subLine(offer, buyHere, usdGbp)
  // Choose goes once pressed, so the keyboard moves on to the first way to buy.
  const actions = useRef<HTMLSpanElement>(null)
  const was = useRef(chosen)
  useEffect(() => {
    if (chosen && !was.current)
      actions.current?.querySelector<HTMLElement>("a, button")?.focus()
    was.current = chosen
  }, [chosen])
  // Inside Choose, the sub line and badge describe the button, not name it.
  const face = (inButton: boolean) => (
    <>
      <span className="flex min-w-0 flex-1 basis-40 flex-col gap-0.5">
        <span className="truncate font-medium text-sm" title={offer.name}>
          {inButton ? <span className="sr-only">Choose </span> : null}
          {offer.name}
        </span>
        {sub ? (
          <span
            aria-hidden={inButton || undefined}
            className={cn(META, "tabular-nums")}
            id={`${id}-sub`}
          >
            {sub}
          </span>
        ) : null}
      </span>
      {offer.why ? (
        <Badge
          aria-hidden={inButton || undefined}
          className="shrink-0"
          variant="secondary"
        >
          Recommended
        </Badge>
      ) : null}
    </>
  )
  if (!chosen) {
    return (
      <li>
        <button
          aria-describedby={
            cn(sub && `${id}-sub`, offer.why && `${id}-why`) || undefined
          }
          className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start outline-none transition-colors duration-fast hover:bg-foreground/5 focus-visible:ring-3 focus-visible:ring-ring"
          onClick={onChoose}
          type="button"
        >
          {face(true)}
          <span
            aria-hidden
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Choose
          </span>
        </button>
        {offer.why ? (
          <span className="sr-only" id={`${id}-why`}>
            Recommended. {offer.why}
          </span>
        ) : null}
      </li>
    )
  }
  const links = buyElsewhereLinks(offer.name)
  return (
    <li
      aria-current="true"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-primary/5 px-3 py-2.5 outline-1 outline-foreground outline-solid -outline-offset-1"
      data-slot="domain-chosen"
    >
      {face(false)}
      <span className="flex w-full flex-wrap gap-2 sm:w-auto" ref={actions}>
        {buyHere && offer.price ? (
          <Button className={ENTER} onClick={onBuyHere} size="sm" type="button">
            {`Buy for ${pounds(offer.price)}`}
          </Button>
        ) : null}
        {PROVIDERS.map((provider) => (
          <a
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              ENTER
            )}
            href={links[provider.id]}
            key={provider.id}
            onClick={onFollow}
            rel="noopener noreferrer"
            target="_blank"
          >
            <img
              alt=""
              className="size-4 object-contain"
              draggable={false}
              src={markOf(provider.id)}
            />
            {`Buy from ${provider.name}`}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ))}
      </span>
    </li>
  )
}

/**
 * Choosing a domain, in the assistant's message: the names as rows under
 * one title, then Skip for now and, once a provider was opened, I've bought
 * it. Both are the owner's words in the chat, so the assistant answers.
 */
function DomainPicker({
  rows,
  buyHere,
  usdGbp,
  picked,
  followed,
  onChoose,
  onFollow,
  onBuyHere,
}: {
  rows: readonly DomainStemOffer[]
  buyHere: boolean
  usdGbp?: number | undefined
  picked: string | null
  followed: boolean
  onChoose: (name: string) => void
  onFollow: (name: string) => void
  onBuyHere: (name: string) => void
}) {
  const aui = useAui()
  const busy = useAuiState((s) => s.thread.isRunning)
  const published = useLiveCards()?.published === true
  const [sent, setSent] = useState(false)
  const say = (text: string) => {
    setSent(true)
    aui.thread().append(text)
  }
  const id = useId()
  return (
    <section
      aria-labelledby={id}
      className="my-3 flex max-w-xl flex-col gap-3"
      data-slot="domain-picker"
    >
      <div className="flex flex-col gap-0.5 px-1">
        <h3 className="font-medium text-sm" id={id}>
          Choose your domain
        </h3>
        {published ? null : <p className={META}>{PICKER_HINT}</p>}
      </div>
      <ul
        aria-label="Domains"
        className="flex flex-col gap-1 rounded-2xl border border-border bg-card p-1 text-card-foreground"
      >
        {shortlist(rows).map((offer) => (
          <PickerRow
            buyHere={buyHere}
            chosen={picked === offer.name}
            key={offer.name}
            offer={offer}
            onBuyHere={() => onBuyHere(offer.name)}
            onChoose={() => onChoose(offer.name)}
            onFollow={() => onFollow(offer.name)}
            usdGbp={usdGbp}
          />
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        {picked && followed ? (
          <Button
            disabled={sent || busy}
            onClick={() => say(pageAction("bought", picked).ask)}
            size="sm"
            type="button"
          >
            I've bought it
          </Button>
        ) : null}
        <Button
          disabled={sent || busy}
          onClick={() => say(SKIP_DOMAIN)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Skip for now
        </Button>
      </div>
    </section>
  )
}

/* Your details ------------------------------------------------------------ */

const TYPES: Record<RegistrantType, string> = {
  STRA: "Sole trader",
  LTD: "Limited company",
  LLP: "Limited liability partnership",
  PTNR: "Partnership",
  IND: "Individual",
}

const MESSAGES = {
  name: "Write your full name.",
  business_name: "Write your business's name.",
  email: "Write an email address you read.",
  phone: "Write a phone number, such as 07700 900123.",
  street: "Write the street address.",
  city: "Write the town or city.",
  state: "Check the county.",
  postal_code: "Write the postcode.",
  country_code: "Write the two-letter country code, such as GB.",
  registrant_type: "Choose what kind of business this is.",
  company_number: "Write the 8-character Companies House number.",
} satisfies Record<RegistrantField, string>

/** A form value, trimmed, or undefined when empty. */
const field = (data: FormData, key: string) => {
  const value = String(data.get(key) ?? "").trim()
  return value || undefined
}

/**
 * The details from the form, checked against the contract and the rules a
 * .co.uk or .uk adds. Errors are keyed by the field's name.
 */
export function readDetails(
  name: string,
  data: FormData
):
  | { ok: true; details: RegistrantDetails }
  | { ok: false; errors: Partial<Record<RegistrantField, string>> } {
  const typed = needsRegistrantType(name)
  const type = field(data, "registrant_type") as RegistrantType | undefined
  const company = field(data, "company_number")?.replace(/\s/g, "")
  const phone = field(data, "phone")
  const candidate = {
    registrant: {
      name: field(data, "name"),
      business_name: field(data, "business_name"),
      email: field(data, "email"),
      phone: phone ? (toE164(phone) ?? phone) : undefined,
      address: {
        street: field(data, "street"),
        city: field(data, "city"),
        state: field(data, "state"),
        postal_code: field(data, "postal_code")?.toUpperCase(),
        country_code: field(data, "country_code")?.toUpperCase(),
      },
    },
    registrant_type: typed ? type : undefined,
    company_number:
      typed && (type === "LTD" || type === "LLP")
        ? company?.toUpperCase()
        : undefined,
  }
  const errors: Partial<Record<RegistrantField, string>> = {}
  const parsed = RegistrantDetails.safeParse(candidate)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path.at(-1) ?? "") as RegistrantField
      errors[key] ??= MESSAGES[key] ?? "Check this."
    }
  }
  if (typed) {
    if (!type) errors.registrant_type ??= MESSAGES.registrant_type
    if (type !== "IND" && !candidate.registrant.business_name) {
      errors.business_name ??= MESSAGES.business_name
    }
  }
  if ((type === "LTD" || type === "LLP") && !candidate.company_number) {
    errors.company_number ??= MESSAGES.company_number
  }
  return parsed.success && Object.keys(errors).length === 0
    ? { ok: true, details: parsed.data }
    : { ok: false, errors }
}

/**
 * The text fields of the details page, in its order, with their labels and how
 * many of six columns each takes from a small screen up: pairs share a row,
 * the street has one to itself.
 */
const TEXT_FIELDS = [
  ["name", "Your full name", "sm:col-span-3", { autoComplete: "name" }],
  [
    "business_name",
    "Business name",
    "sm:col-span-3",
    { autoComplete: "organization" },
  ],
  ["email", "Email", "sm:col-span-3", { autoComplete: "email", type: "email" }],
  ["phone", "Phone", "sm:col-span-3", { autoComplete: "tel", type: "tel" }],
  [
    "street",
    "Street address",
    "sm:col-span-6",
    { autoComplete: "street-address" },
  ],
  ["city", "Town or city", "sm:col-span-3", { autoComplete: "address-level2" }],
  ["postal_code", "Postcode", "sm:col-span-3", { autoComplete: "postal-code" }],
  [
    "state",
    "County (optional)",
    "sm:col-span-4",
    { autoComplete: "address-level1" },
  ],
  [
    "country_code",
    "Country code",
    "sm:col-span-2",
    { autoComplete: "country", maxLength: 2 },
  ],
] as const satisfies [RegistrantField, string, string, object][]

/** The field each shares a row with, which takes the whole row when it is not asked. */
const PARTNER: Partial<Record<RegistrantField, RegistrantField>> = {
  name: "business_name",
  business_name: "name",
  email: "phone",
  phone: "email",
  city: "postal_code",
  postal_code: "city",
  state: "country_code",
  country_code: "state",
}

/** What the prefill holds for a field, as the form's text. */
function prefilled(prefill: DomainRegistrantPrefill, key: RegistrantField) {
  const { address, ...who } = prefill.registrant
  const flat: Record<string, string | undefined> = { ...who, ...address }
  return flat[key]
}

/**
 * The purchase's status, read when the page shows and again while it moves:
 * every few seconds while registering, and while Checkout is open, so an
 * expiry is seen. `undefined` until the first read answers; a read that
 * fails counts as none, and the api refuses a second payment. `paid` is
 * Checkout's word that the payment completed on this page.
 */
function usePurchaseStatus(
  purchase: DomainPurchase | null,
  name: string,
  paid: boolean,
  paying: boolean
): PurchaseStatus | null | undefined {
  // Each read is kept with the `paying` it was made under. A read from before
  // Pay says nothing about the Checkout just opened, so it is not returned,
  // even on the render where Pay starts (an earlier abandoned purchase of the
  // name would otherwise close the new dialog at once).
  const [kept, setKept] = useState<{
    paying: boolean
    status: PurchaseStatus | null | undefined
  }>({ paying, status: purchase ? undefined : null })
  useEffect(() => {
    if (!purchase) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    setKept({ paying, status: undefined })
    const read = async () => {
      const next =
        (await purchase.status(name).then(purchaseStatusOf, () => null)) ??
        (paid ? "authorised" : null)
      if (!live) return
      setKept({ paying, status: next })
      if (next && MOVING.has(next)) timer = setTimeout(read, REREAD_MS)
      else if (!next && paying) timer = setTimeout(read, PAYING_REREAD_MS)
    }
    void read()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [purchase, name, paid, paying])
  if (!purchase) return null
  return kept.paying === paying ? kept.status : undefined
}

const STATUS_TEXT: Record<PurchaseStatus, (name: string) => string> = {
  authorised: (name) =>
    `Payment approved. I'm registering ${name} now and will message you when it's done.`,
  serving: (name) =>
    `${name} is registered to your business. Your website goes on it in the next few minutes.`,
  registered: (name) => `${name} is yours, and your website is on it.`,
  test: (name) =>
    `Test purchase complete: paid in test mode, registered in Cloudflare's sandbox, not live on the internet. No real money moved for ${name}.`,
  failed: (name) =>
    `${name} could not be registered, so your card was not charged.`,
  price_changed: (name) =>
    `The price of ${name} went up before it could be registered, so your card was not charged.`,
  unavailable: (name) =>
    `Someone registered ${name} first, so your card was not charged.`,
  abandoned: (name) =>
    `The payment for ${name} timed out before it was made, so nothing was charged.`,
  removed: (name) => `${name} is yours, and no longer on your website.`,
}

const TICKED = new Set<PurchaseStatus>([
  "authorised",
  "serving",
  "registered",
  "test",
  "removed",
])

/** Statuses that change on their own, so they are read again. */
const MOVING = new Set<PurchaseStatus>(["authorised", "serving"])
/** Statuses after which a fresh Pay can still buy the name. */
const PAYABLE = new Set<PurchaseStatus>([
  "abandoned",
  "failed",
  "price_changed",
])
const REREAD_MS = 5000
// While Checkout is open, so an expired one says so instead of Stripe's
// "You're all done here", which reads the same for paid and timed out.
const PAYING_REREAD_MS = 20_000

/** A purchase's status as its one line in the thread. */
function StatusLine({
  name,
  status,
}: {
  name: string
  status: PurchaseStatus
}) {
  const ticked = TICKED.has(status)
  return (
    <p
      className="my-3 flex max-w-md items-start gap-2 text-sm"
      data-slot="buy-domain"
      role="status"
    >
      {ticked ? <DoneIcon className="mt-0.5" /> : null}
      {STATUS_TEXT[status](name)}
    </p>
  )
}

/** Where Your details is: filling in, opening Checkout, paying, or refused. */
type Phase =
  | { at: "filling" }
  | { at: "starting" }
  | {
      at: "paying"
      publishable_key: string
      client_secret: string
      details: RegistrantDetails
    }
  | { at: "refused"; code: string | null }

function DetailsPage({
  name,
  given,
  frame,
  onBack,
  onPaid,
  onSettled,
}: {
  name: string
  /** What `buy_domain` already prefilled, so the page needs no read of its own. */
  given?: DomainRegistrantPrefill | undefined
  frame: Frame
  /** Back to Choose, when the page came from it. */
  onBack?: (() => void) | undefined
  /** Checkout completed on the page. */
  onPaid: () => void
  /** The name's purchase already went past paying: its line takes over. */
  onSettled: () => void
}) {
  const purchase = useContext(DomainPurchaseContext)
  const id = useId()
  const [prefill, setPrefill] = useState<
    DomainRegistrantPrefill | Refused | undefined
  >(given)
  const [phase, setPhase] = useState<Phase>({ at: "filling" })
  // Pay pressed on this page: only then is a lapsed or refused purchase news
  // here. An earlier one's outcome was said in the chat when it happened.
  const [tried, setTried] = useState(false)
  const [errors, setErrors] = useState<
    Partial<Record<RegistrantField, string>>
  >({})
  const [all, setAll] = useState(false)
  const [type, setType] = useState<RegistrantType>()
  const status = usePurchaseStatus(purchase, name, false, phase.at === "paying")

  useEffect(() => {
    if (!purchase || given) return
    let live = true
    purchase.registrant(name).then(
      (read) => live && setPrefill(read),
      () => live && setPrefill({ refused: null })
    )
    return () => {
      live = false
    }
  }, [purchase, name, given])

  // Paid or taken already: the thread says so in a line. An expiry while
  // Checkout is open closes it and leaves a fresh Pay.
  useEffect(() => {
    if (!status) return
    if (!PAYABLE.has(status)) onSettled()
    else if (phase.at === "paying") setPhase({ at: "filling" })
  }, [status, phase.at, onSettled])

  const ask =
    prefill && !("refused" in prefill)
      ? new Set<RegistrantField>(
          all ? TEXT_FIELDS.map(([k]) => k) : prefill.missing
        )
      : null
  const price =
    prefill && !("refused" in prefill) ? prefill.price_gbp_year : null

  const pay = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!purchase) return
    const read = readDetails(name, new FormData(event.currentTarget))
    if (!read.ok) {
      setErrors(read.errors)
      // A prefilled value that does not read is shown so it can be fixed.
      if (TEXT_FIELDS.some(([key]) => read.errors[key] && !ask?.has(key))) {
        setAll(true)
      }
      return
    }
    setErrors({})
    setTried(true)
    setPhase({ at: "starting" })
    try {
      const started = await purchase.checkout(name, read.details)
      setPhase(
        started.outcome === "open"
          ? { at: "paying", ...started, details: read.details }
          : { at: "refused", code: started.code }
      )
    } catch {
      setPhase({ at: "refused", code: null })
    }
  }

  const ready = ask !== null && price !== null && status !== undefined
  const refused = !purchase
    ? "domain.buy_unavailable"
    : prefill && "refused" in prefill
      ? (prefill.refused ?? "")
      : phase.at === "refused"
        ? (phase.code ?? "")
        : null
  // The form may be scrolled to Pay, so a refusal is brought into view.
  const alert = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (refused !== null) alert.current?.scrollIntoView({ block: "nearest" })
  }, [refused])

  return (
    <TrayFrame
      {...frame}
      hint={
        price === null
          ? name
          : `${name}, ${pounds(price)} for 1 year, renews yearly`
      }
      question="Your details"
      skip={onBack ? { label: "Back", onSkip: onBack } : undefined}
      status={
        tried && status && PAYABLE.has(status)
          ? STATUS_TEXT[status](name)
          : undefined
      }
      submit={
        ready && refused !== "domain.buy_unavailable"
          ? {
              label:
                phase.at === "starting"
                  ? "Opening payment"
                  : `Pay ${pounds(price)}`,
              form: `${id}-form`,
              disabled: phase.at === "starting" || phase.at === "paying",
            }
          : undefined
      }
    >
      {refused !== null ? (
        <div className="px-2" ref={alert} role="alert">
          <Problem
            text={refusalText(
              refused || null,
              "The payment could not be started. Try again."
            )}
          />
        </div>
      ) : null}
      {ask === null ? (
        refused === null ? (
          <p aria-busy className={cn(META, "px-2")} role="status">
            Getting your details
          </p>
        ) : null
      ) : (
        <form
          aria-label="Registration details"
          className="grid grid-cols-6 gap-3 px-2 pb-1"
          id={`${id}-form`}
          noValidate
          onSubmit={pay}
        >
          {all ? null : (
            <p className={cn(META, "col-span-6")}>
              {ask.size === 0
                ? "We have everything we need to register it in your business's name."
                : "We filled in what we know. Add the rest to register it in your business's name."}{" "}
              <button
                className="rounded-sm underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
                onClick={() => setAll(true)}
                type="button"
              >
                Check every detail
              </button>
            </p>
          )}
          {TEXT_FIELDS.map(([key, label, span, extra]) => {
            const partner = PARTNER[key]
            const value =
              prefill && !("refused" in prefill)
                ? prefilled(prefill, key)
                : undefined
            return ask.has(key) ? (
              <Field
                className={cn(
                  "col-span-6",
                  partner && ask.has(partner) ? span : "sm:col-span-6"
                )}
                error={errors[key]}
                id={`${id}-${key}`}
                key={key}
                label={label}
              >
                {(wiring) => (
                  <Input
                    {...wiring}
                    className={TRAY_FIELD}
                    defaultValue={value}
                    name={key}
                    {...extra}
                  />
                )}
              </Field>
            ) : (
              <input key={key} name={key} type="hidden" value={value ?? ""} />
            )
          })}
          {needsRegistrantType(name) ? (
            <fieldset className="col-span-6 flex flex-col gap-2">
              <legend className="mb-2 text-sm">Kind of business</legend>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(TYPES) as RegistrantType[]).map((each) => (
                  <label
                    className={cn(OPTION, OPTION_PILL, "gap-2")}
                    key={each}
                  >
                    <input
                      className="accent-primary"
                      name="registrant_type"
                      onChange={() => setType(each)}
                      type="radio"
                      value={each}
                    />
                    {TYPES[each]}
                  </label>
                ))}
              </div>
              {errors.registrant_type ? (
                <p className={FIELD_ERROR} role="alert">
                  {errors.registrant_type}
                </p>
              ) : null}
            </fieldset>
          ) : null}
          {type === "LTD" || type === "LLP" ? (
            <Field
              autoCapitalize="characters"
              className="col-span-6"
              error={errors.company_number}
              id={`${id}-company_number`}
              label="Companies House number"
              maxLength={8}
              name="company_number"
            />
          ) : null}
          <p className={cn(META, "col-span-6")}>
            Hidden from public WHOIS where the registry allows. It's yours: you
            can move it away any time after 60 days. By paying you authorise
            Reme to register it in your business's name and accept the{" "}
            <Out href={AGREEMENT}>Cloudflare Domain Registration Agreement</Out>{" "}
            and <Out href={ICANN}>ICANN registrant rights</Out>.
          </p>
        </form>
      )}
      {phase.at === "paying" && price !== null ? (
        <PayDialog
          clientSecret={phase.client_secret}
          name={name}
          // Closed unpaid: the next Pay opens a fresh Checkout.
          onClose={() => setPhase({ at: "filling" })}
          onPaid={onPaid}
          priceGbp={price}
          publishableKey={phase.publishable_key}
          registrant={phase.details.registrant}
        />
      ) : null}
    </TrayFrame>
  )
}

/* The tray ------------------------------------------------------------------ */

/** The frame state every page shares. */
type Frame = {
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
}

/**
 * Where the buy flow is. Kept in the tab, so a reload resumes there and an
 * ended one stays one line.
 */
type Draft =
  | { at: "choose"; picked?: string; followed?: boolean }
  | { at: "details"; name: string }
  /** Paid on this page, or found past paying already. */
  | { at: "bought"; name: string; paid: boolean }

/** A purchase's line in the thread, read from the api. */
function BoughtLine({ name, paid }: { name: string; paid: boolean }) {
  const purchase = useContext(DomainPurchaseContext)
  const status = usePurchaseStatus(purchase, name, paid, false)
  return status ? <StatusLine name={name} status={status} /> : null
}

/** Whether the owner pressed this list's Skip for now in a later message. */
function useSkipped(): boolean {
  return useAuiState((s) => {
    const at = s.thread.messages.findIndex((m) => m.id === s.message.id)
    return s.thread.messages
      .slice(at + 1)
      .some(
        (m) =>
          m.role === "user" &&
          m.content.some((p) => p.type === "text" && p.text === SKIP_DOMAIN)
      )
  })
}

/**
 * The buy flow for one call or posted button. `find_domain`'s names stay in
 * the message until the owner moves on: a later search replaces them, and
 * Skip for now or another domain card folds them to one line. While buying
 * here is on, a chosen name's Your details dock in the tray until the owner
 * says something after it.
 */
export function BuyTray({
  draftId,
  rows,
  buyHere = false,
  usdGbp,
  name,
  prefill,
}: {
  draftId: string
  /** The names to choose from; without them it opens on Your details for `name`. */
  rows?: readonly DomainStemOffer[] | undefined
  /** Buying here is on, so a name can go on to Your details. */
  buyHere?: boolean
  /** Pounds per dollar, for Cloudflare's price in pounds. */
  usdGbp?: number | undefined
  name?: string | undefined
  /** Your details for `name` as `buy_domain` prefilled them. */
  prefill?: DomainRegistrantPrefill | undefined
}) {
  const purchase = useContext(DomainPurchaseContext)
  const last = useAuiState((s) => {
    const at = s.thread.messages.findIndex((m) => m.id === s.message.id)
    return !s.thread.messages.slice(at + 1).some((m) => m.role === "user")
  })
  const later = useLaterDomainCard()
  const skipped = useSkipped()
  const start: Draft = rows
    ? { at: "choose" }
    : { at: "details", name: name ?? "" }
  const { draft, keep } = useTabDraft<Draft>(`buy:${draftId}`, start)
  const [collapsed, setCollapsed] = useState(false)
  const frame = { collapsed, onCollapsedChange: setCollapsed }

  if (draft.at === "bought") {
    return <BoughtLine name={draft.name} paid={draft.paid} />
  }
  const details =
    draft.at === "details" && last ? (
      <Docked name="buy-domain">
        <DetailsPage
          frame={frame}
          given={prefill?.name === draft.name ? prefill : undefined}
          name={draft.name}
          onBack={rows ? () => keep({ at: "choose" }) : undefined}
          onPaid={() => keep({ at: "bought", name: draft.name, paid: true })}
          onSettled={() =>
            keep({ at: "bought", name: draft.name, paid: false })
          }
        />
      </Docked>
    ) : null
  if (!rows) return details
  if (later === "find_domain") {
    return (
      <Line
        text={
          skipped
            ? "You skipped choosing, so there's a fresh list below."
            : "There's a fresh list below."
        }
      />
    )
  }
  if (later || skipped) {
    const offered = rows.flatMap((r) =>
      offersOf(r)
        .slice(0, 1)
        .map((o) => o.name)
    )
    return offered.length ? (
      <Line text={`Names I offered: ${offered.join(", ")}.`} />
    ) : null
  }
  const choosing = draft.at === "choose" ? draft : null
  // A lost note only skips the daily registry look: "I've bought it" asks
  // the registry itself.
  const follow = (picked: string) => {
    keep({ at: "choose", picked, followed: true })
    void purchase?.elsewhere(picked).catch(() => undefined)
  }
  return (
    <>
      <DomainPicker
        buyHere={buyHere}
        followed={choosing?.followed === true}
        onBuyHere={(picked) => keep({ at: "details", name: picked })}
        onChoose={(picked) => keep({ at: "choose", picked })}
        onFollow={follow}
        picked={
          choosing?.picked ?? (draft.at === "details" ? draft.name : null)
        }
        rows={rows}
        usdGbp={usdGbp}
      />
      {details}
    </>
  )
}

export const FindDomain: ToolCallMessagePartComponent = (props) => {
  const streaming = useAuiState((s) => s.message.status?.type === "running")
  const view = readView(props, FindDomainOutput)
  if (view.state !== "done") {
    return (
      <div data-slot="find-domain">
        <ToolLine
          args={{
            query: FindDomainInput.safeParse(props.args).data?.query,
            step: stepOf(props),
          }}
          state={view.state}
          streaming={streaming}
          tool="find_domain"
        />
      </div>
    )
  }
  if (view.output.outcome === "refused") {
    return (
      <div data-slot="find-domain">
        <Line
          text={
            view.output.error.code === "domain.unavailable"
              ? "None of the names I tried are free. Tell me words you'd like in it and I'll look again."
              : refusalText(
                  view.output.error.code,
                  "I couldn't look for a name just now."
                )
          }
        />
      </div>
    )
  }
  // A search from before the name rows: its offers are stale, so one line.
  if (!("rows" in view.output)) {
    return (
      <div data-slot="find-domain">
        <Line text="I suggested some names here earlier. Ask me to look again for today's prices." />
      </div>
    )
  }
  return (
    <>
      <ToolStatus
        args={{ count: shortlist(view.output.rows).length }}
        className="flex px-1 py-1.5 text-sm"
        state="done"
        tool="find_domain"
      />
      <BuyTray
        buyHere={view.output.buy_here === true}
        draftId={props.toolCallId}
        rows={view.output.rows}
        usdGbp={view.output.usd_gbp}
      />
    </>
  )
}
FindDomain.displayName = "FindDomain"

export const BuyDomain: ToolCallMessagePartComponent = (props) => {
  const streaming = useAuiState((s) => s.message.status?.type === "running")
  const view = readView(props, BuyDomainOutput)
  if (view.state !== "done") {
    return (
      <div data-slot="buy-domain">
        <ToolLine
          args={{ domain: BuyDomainInput.safeParse(props.args).data?.name }}
          state={view.state}
          streaming={streaming}
          tool="buy_domain"
        />
      </div>
    )
  }
  if (view.output.outcome === "refused") {
    return (
      <div data-slot="buy-domain">
        <Problem
          text={refusalText(
            view.output.error.code,
            "That domain could not be bought."
          )}
        />
      </div>
    )
  }
  const { output } = view
  return (
    <BuyTray
      draftId={props.toolCallId}
      name={output.name}
      prefill={output.outcome === "details" ? output : undefined}
    />
  )
}
BuyDomain.displayName = "BuyDomain"
