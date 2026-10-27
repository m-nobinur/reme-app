import {
  type ToolCallMessagePartComponent,
  useAuiState,
} from "@assistant-ui/react"
import { ArrowSquareOutIcon, CheckCircleIcon } from "@phosphor-icons/react"
import {
  type BoughtElsewhereOutput,
  BuyDomainInput,
  BuyDomainOutput,
  buyElsewhereLinks,
  type DomainPurchaseStatus,
  type DomainRegistrantPrefill,
  type DomainStemOffer,
  type DomainTld,
  FindDomainInput,
  FindDomainOutput,
  needsRegistrantType,
  RegistrantDetails,
  type RegistrantField,
  type RegistrantType,
  toE164,
} from "@workspace/contracts"
import { Done, Problem } from "@workspace/ui/components/assistant/decision"
import { ConnectSteps } from "@workspace/ui/components/assistant/domain"
import { PayDialog } from "@workspace/ui/components/assistant/pay-dialog"
import {
  Docked,
  TRAY_FIELD,
  TrayFrame,
  useTabDraft,
} from "@workspace/ui/components/assistant/question-tray"
import { Badge } from "@workspace/ui/components/badge"
import { ConnectRow, ConnectRows } from "@workspace/ui/components/connect-row"
import { Field } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { ToolStatus } from "@workspace/ui/components/status-line"
import type { ToolArgs } from "@workspace/ui/lib/activity-copy"
import { FIELD_ERROR, OPTION, OPTION_PILL } from "@workspace/ui/lib/card"
import { refusalText } from "@workspace/ui/lib/refusal"
import { type Failure, readView } from "@workspace/ui/lib/tool-state"
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
 * Buying a domain, in the question tray. `find_domain`'s rows open it on
 * Choose: a card for each free full domain with its yearly price, best
 * first, and "Buy it somewhere else" under them. A card goes
 * to Your details, prefilled from what the api holds and asking only for
 * the gaps, and Pay opens the payment dialog on the purchase's Stripe
 * Checkout Session, where paying is the consent. Buying elsewhere opens
 * Cloudflare's or GoDaddy's search and leaves the tray waiting for "Done, I bought it". `buy_domain`
 * and a posted Pay button open Your details for their name. The price shown
 * is the api's, from the price table, never the model's text. Done, the
 * tray goes and the thread keeps one line.
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
  /** The owner says they bought it. */
  bought: (name: string) => Promise<BoughtElsewhereOutput | Refused>
}

const DomainPurchaseContext = createContext<DomainPurchase | null>(null)

/** Gives the buy tray the app's purchase calls. */
export const DomainPurchaseProvider = DomainPurchaseContext.Provider

const AGREEMENT = "https://www.cloudflare.com/domain-registration-agreement"
const ICANN = "https://www.icann.org/resources/pages/benefits-2013-09-16-en"

const pounds = (gbp: number) => `£${gbp}`

/** The endings a row offers, in the order its cards show them. */
const ENDINGS = ["co.uk", "com", "uk"] as const satisfies DomainTld[]

/** One free full domain, which is one card. */
type Offer = { name: string; price: number; why: string }

/** The free names of the rows, best first; a taken ending is no card. */
const offersOf = (rows: readonly DomainStemOffer[]): Offer[] =>
  rows.flatMap((row) =>
    ENDINGS.flatMap((tld) => {
      const ending = row.endings[tld]
      return ending?.state === "free"
        ? [
            {
              name: `${row.stem}.${tld}`,
              price: ending.price_gbp_year,
              why: row.why,
            },
          ]
        : []
    })
  )

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

/**
 * One free domain: its name, then its yearly price. The cards are the radios
 * of the grid's one group, so the arrow keys and the announcing are the
 * browser's. The best one wears a pill on its top edge, which also describes
 * the card to a screen reader with the reason.
 */
function NameCard({
  offer,
  best,
  group,
  picked,
  onPick,
}: {
  offer: Offer
  best: boolean
  group: string
  picked: string | null
  onPick: (name: string) => void
}) {
  const pill = `${group}-best`
  return (
    <label
      className={cn(
        OPTION,
        "group min-w-0 flex-col gap-0.5 rounded-xl p-3 pe-9 has-[:checked]:inset-ring-1 has-[:checked]:inset-ring-primary"
      )}
    >
      <input
        aria-describedby={best ? pill : undefined}
        aria-label={`${offer.name}, ${pounds(offer.price)} a year`}
        checked={picked === offer.name}
        className="sr-only"
        name={group}
        onChange={() => onPick(offer.name)}
        type="radio"
        value={offer.name}
      />
      {best ? (
        <Badge className="absolute end-3 -top-2.5" id={pill}>
          Best pick
          <span className="sr-only">. {offer.why}</span>
        </Badge>
      ) : null}
      <span className="truncate font-medium" title={offer.name}>
        {offer.name}
      </span>
      <span className={cn(META, "tabular-nums")}>
        {pounds(offer.price)} a year
      </span>
      <CheckCircleIcon
        aria-hidden
        className="absolute end-3 bottom-3 hidden size-5 text-primary group-has-[:checked]:block"
        weight="fill"
      />
    </label>
  )
}

/** The links that buy a name elsewhere; following one tells the api. */
function Elsewhere({
  name,
  onFollow,
}: {
  name: string
  onFollow?: () => void
}) {
  const links = buyElsewhereLinks(name)
  return (
    <>
      <ConnectRows heading="Other places to buy it">
        <ConnectRow
          href={links.cloudflare}
          line={`Search for ${name}`}
          name="Cloudflare"
          newTab
          onClick={onFollow}
        />
        <ConnectRow
          href={links.godaddy}
          line={`Search for ${name}`}
          name="GoDaddy"
          newTab
          onClick={onFollow}
        />
      </ConnectRows>
      <p className={META}>
        You manage it there, and I connect it once it's yours.
      </p>
    </>
  )
}

function ChoosePage({
  rows,
  frame,
  onPick,
  onElsewhere,
  onNotNow,
}: {
  rows: readonly DomainStemOffer[]
  frame: Frame
  onPick: (name: string) => void
  onElsewhere: (name: string) => void
  onNotNow: () => void
}) {
  const [away, setAway] = useState(false)
  const offers = offersOf(rows)
  const best = offers[0]?.name ?? null
  const [picked, setPicked] = useState(best)
  const group = useId()
  // The rows open under the list, so they are brought into view.
  const places = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (away) places.current?.scrollIntoView({ block: "nearest" })
  }, [away])
  return (
    <TrayFrame
      {...frame}
      hint="We register it in your business's name, renew it every year and handle the settings."
      question="Choose your web address"
      skip={{ label: "Not now", onSkip: onNotNow }}
      submit={{
        label: "Continue",
        onSubmit: () => picked && onPick(picked),
        disabled: !picked,
      }}
    >
      {/* Two to a row at any width: three would strand the fourth name. The top padding clears the best card's pill. */}
      <div
        aria-label="Web address"
        className="grid grid-cols-2 gap-2 px-2 pt-2"
        role="radiogroup"
      >
        {offers.map((offer, at) => (
          <NameCard
            best={at === 0}
            group={group}
            key={offer.name}
            offer={offer}
            onPick={setPicked}
            picked={picked}
          />
        ))}
      </div>
      {best ? (
        <div className="flex flex-col gap-2 px-2 pb-1">
          <button
            aria-expanded={away}
            className="self-start rounded-sm text-sm underline decoration-muted-foreground/60 underline-offset-3 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-primary"
            onClick={() => setAway(!away)}
            type="button"
          >
            Buy it somewhere else
          </button>
          {away ? (
            <div className="flex flex-col gap-2" ref={places}>
              <Elsewhere name={best} onFollow={() => onElsewhere(best)} />
            </div>
          ) : null}
        </div>
      ) : null}
    </TrayFrame>
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

/** The text fields of the details page, in its order, with their labels. */
const TEXT_FIELDS = [
  ["name", "Your full name", { autoComplete: "name" }],
  ["business_name", "Business name", { autoComplete: "organization" }],
  ["email", "Email", { autoComplete: "email", type: "email" }],
  ["phone", "Phone", { autoComplete: "tel", type: "tel" }],
  ["street", "Street address", { autoComplete: "street-address" }],
  ["city", "Town or city", { autoComplete: "address-level2" }],
  ["state", "County (optional)", { autoComplete: "address-level1" }],
  ["postal_code", "Postcode", { autoComplete: "postal-code" }],
  ["country_code", "Country code", { autoComplete: "country", maxLength: 2 }],
] as const satisfies [RegistrantField, string, object][]

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
  const [status, setStatus] = useState<PurchaseStatus | null | undefined>(
    purchase ? undefined : null
  )
  useEffect(() => {
    if (!purchase) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    // A read from before Pay says nothing about the Checkout just opened.
    setStatus(undefined)
    const read = async () => {
      const next =
        (await purchase.status(name).then(purchaseStatusOf, () => null)) ??
        (paid ? "authorised" : null)
      if (!live) return
      setStatus(next)
      if (next && MOVING.has(next)) timer = setTimeout(read, REREAD_MS)
      else if (!next && paying) timer = setTimeout(read, PAYING_REREAD_MS)
    }
    void read()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [purchase, name, paid, paying])
  return status
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
      {ticked ? (
        <CheckCircleIcon
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-primary"
        />
      ) : null}
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
        status && PAYABLE.has(status) ? STATUS_TEXT[status](name) : undefined
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
          className="flex flex-col gap-3 px-2 pb-1"
          id={`${id}-form`}
          noValidate
          onSubmit={pay}
        >
          {all ? null : (
            <p className={META}>
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
          {TEXT_FIELDS.map(([key, label, extra]) => {
            const value =
              prefill && !("refused" in prefill)
                ? prefilled(prefill, key)
                : undefined
            return ask.has(key) ? (
              <Field
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
            <fieldset className="flex flex-col gap-2">
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
              error={errors.company_number}
              id={`${id}-company_number`}
              label="Companies House number"
              maxLength={8}
              name="company_number"
            />
          ) : null}
          <p className={META}>
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

/* Bought elsewhere ---------------------------------------------------------- */

function WaitingPage({
  name,
  frame,
  onBack,
  onBought,
}: {
  name: string
  frame: Frame
  onBack: () => void
  onBought: (output: Connecting) => void
}) {
  const purchase = useContext(DomainPurchaseContext)
  const [sending, setSending] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const done = async () => {
    if (!purchase) return
    setSending(true)
    setSaid(null)
    const answer = await purchase.bought(name).catch(() => ({ refused: null }))
    setSending(false)
    if ("refused" in answer) {
      setSaid(refusalText(answer.refused, "That didn't go through. Try again."))
    } else if (answer.outcome === "connecting") {
      onBought(answer)
    } else if (answer.outcome === "not_registered_yet") {
      setSaid(
        `I can't see ${name} at the registry yet. It can take a few minutes, and I check each day too.`
      )
    } else {
      setSaid(refusalText(answer.error.code, "I couldn't connect it just now."))
    }
  }
  return (
    <TrayFrame
      {...frame}
      hint={`Buying ${name}`}
      question="Tell me when you've bought it"
      skip={{ label: "Back", onSkip: onBack, disabled: sending }}
      status={said}
      submit={{
        label: sending ? "Checking" : "Done, I bought it",
        onSubmit: () => void done(),
        disabled: sending,
      }}
    >
      <div className="flex flex-col gap-2 px-2 pb-1">
        <Elsewhere name={name} />
        <p className={META}>
          Your email and anything else there stay as they are.
        </p>
      </div>
    </TrayFrame>
  )
}

/* The tray ------------------------------------------------------------------ */

/** The frame state every page shares. */
type Frame = {
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
}

type Connecting = Extract<BoughtElsewhereOutput, { outcome: "connecting" }>

/**
 * Where the tray is, and how it ended. Kept in the tab, so a reload resumes
 * there and an ended tray stays one line.
 */
type Draft =
  | { at: "choose" }
  | { at: "details"; name: string }
  | { at: "elsewhere"; name: string }
  | { at: "not_now" }
  /** Paid on this page, or found past paying already. */
  | { at: "bought"; name: string; paid: boolean }
  | { at: "connecting"; name: string; output: Connecting }

/** A purchase's line in the thread, read from the api. */
function BoughtLine({ name, paid }: { name: string; paid: boolean }) {
  const purchase = useContext(DomainPurchaseContext)
  const status = usePurchaseStatus(purchase, name, paid, false)
  return status ? <StatusLine name={name} status={status} /> : null
}

/**
 * The buy tray for one call or posted button. It docks until the owner says
 * something after it, which moves the conversation on (they can ask again).
 * A message the assistant posts below it, such as the site going live,
 * leaves it open with what was typed.
 */
export function BuyTray({
  draftId,
  rows,
  name,
  prefill,
}: {
  draftId: string
  /** The names to choose from; without them it opens on Your details for `name`. */
  rows?: readonly DomainStemOffer[] | undefined
  name?: string | undefined
  /** Your details for `name` as `buy_domain` prefilled them. */
  prefill?: DomainRegistrantPrefill | undefined
}) {
  const purchase = useContext(DomainPurchaseContext)
  const last = useAuiState((s) => {
    const at = s.thread.messages.findIndex((m) => m.id === s.message.id)
    return !s.thread.messages.slice(at + 1).some((m) => m.role === "user")
  })
  const start: Draft = rows
    ? { at: "choose" }
    : { at: "details", name: name ?? "" }
  const { draft, keep } = useTabDraft<Draft>(`buy:${draftId}`, start)
  const [collapsed, setCollapsed] = useState(false)
  const frame = { collapsed, onCollapsedChange: setCollapsed }

  switch (draft.at) {
    case "bought":
      return <BoughtLine name={draft.name} paid={draft.paid} />
    case "connecting":
      return (
        <section
          className="my-3 flex max-w-md flex-col gap-2"
          data-slot="buy-domain"
        >
          <Done>{draft.name} is yours. Next, the settings to change.</Done>
          <ConnectSteps name={draft.name} output={draft.output} />
        </section>
      )
    case "not_now":
      return <Line text="You said not now." />
  }
  if (!last) {
    return rows ? (
      <Line
        text={`Names I found: ${rows.map((row) => row.stem).join(", ")}.`}
      />
    ) : null
  }

  return (
    <Docked name="buy-domain">
      {draft.at === "choose" && rows ? (
        <ChoosePage
          frame={frame}
          onElsewhere={(picked) => {
            keep({ at: "elsewhere", name: picked })
            // A lost note only skips the daily registry look: "Done, I
            // bought it" asks the registry itself.
            void purchase?.elsewhere(picked).catch(() => undefined)
          }}
          onNotNow={() => keep({ at: "not_now" })}
          onPick={(picked) => keep({ at: "details", name: picked })}
          rows={rows}
        />
      ) : draft.at === "elsewhere" ? (
        <WaitingPage
          frame={frame}
          name={draft.name}
          onBack={() => keep(start)}
          onBought={(output) =>
            keep({ at: "connecting", name: draft.name, output })
          }
        />
      ) : draft.at === "details" ? (
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
      ) : null}
    </Docked>
  )
}

export const FindDomain: ToolCallMessagePartComponent = (props) => {
  const streaming = useAuiState((s) => s.message.status?.type === "running")
  const view = readView(props, FindDomainOutput)
  if (view.state !== "done") {
    return (
      <div data-slot="find-domain">
        <ToolLine
          args={{ query: FindDomainInput.safeParse(props.args).data?.query }}
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
  return <BuyTray draftId={props.toolCallId} rows={view.output.rows} />
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
