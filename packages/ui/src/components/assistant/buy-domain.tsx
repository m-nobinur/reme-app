import {
  type ToolCallMessagePartComponent,
  useAui,
  useAuiState,
} from "@assistant-ui/react"
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  PencilSimpleIcon,
} from "@phosphor-icons/react"
import {
  BuyDomainInput,
  BuyDomainOutput,
  type DomainOffer,
  type DomainPurchaseStatus,
  FindDomainOutput,
  RegistrantDetails,
  type RegistrantType,
  sellableTld,
} from "@workspace/contracts"
import { Problem } from "@workspace/ui/components/assistant/decision"
import { Button } from "@workspace/ui/components/button"
import { Field } from "@workspace/ui/components/field"
import { toE164 } from "@workspace/ui/lib/answer"
import { CARD_SURFACE, FIELD_ERROR } from "@workspace/ui/lib/card"
import { refusalText } from "@workspace/ui/lib/refusal"
import { mountCheckout } from "@workspace/ui/lib/stripe"
import { readView } from "@workspace/ui/lib/tool-state"
import { cn, META } from "@workspace/ui/lib/utils"
import {
  type ComponentProps,
  createContext,
  type FormEvent,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react"

/**
 * Buying a domain. `find_domain` is a read: the free names it found, each
 * with a button that asks the assistant to buy it in the owner's voice.
 * `buy_domain` prepares a purchase and moves no money, so it has no yes of
 * its own: its card shows what is bought, for how much and in whose name,
 * lets the owner correct the details, and then mounts Stripe's embedded
 * Checkout, where paying is the consent. The price shown is the tool's,
 * which the api took from the price table, never the model's text. What
 * happens after the payment is the purchase's status, read from the app.
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

/** What the card mounts Checkout with, or why it cannot. */
export type CheckoutStart =
  | { outcome: "open"; publishable_key: string; client_secret: string }
  | { outcome: "refused"; code: string | null }

/** What the buy card needs from the app. */
export type DomainPurchase = {
  /** Creates the purchase's Checkout with the details as shown. */
  checkout: (name: string, details: RegistrantDetails) => Promise<CheckoutStart>
  /** The newest purchase of that name, or null when there is none. */
  status: (name: string) => Promise<DomainPurchaseStatus | null>
}

const DomainPurchaseContext = createContext<DomainPurchase | null>(null)

/** Gives the buy card the app's Checkout and purchase status. */
export const DomainPurchaseProvider = DomainPurchaseContext.Provider

const AGREEMENT = "https://www.cloudflare.com/domain-registration-agreement"
const ICANN = "https://www.icann.org/resources/pages/benefits-2013-09-16-en"

/** The message a choose button sends as the owner. */
export const chooseText = (name: string) => `Buy ${name} for me.`

const pounds = (gbp: number) => `£${gbp}`

/* find_domain ----------------------------------------------------------- */

/** One name on offer, with the button that asks for it. */
function Offer({
  offer,
  best,
  disabled,
  onChoose,
}: {
  offer: DomainOffer
  best: boolean
  disabled: boolean
  onChoose: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
      <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        {best ? (
          <span className={cn(META, "text-primary")}>Best pick</span>
        ) : null}
        <span className="break-all font-medium">{offer.name}</span>
        <span className={META}>{offer.why}</span>
      </div>
      <span className="text-sm tabular-nums">
        {pounds(offer.price_gbp_year)} a year
      </span>
      <Button
        aria-label={`Choose ${offer.name}`}
        disabled={disabled}
        onClick={onChoose}
        size="sm"
        type="button"
        variant={best ? "default" : "outline"}
      >
        Choose
      </Button>
    </div>
  )
}

/** A line while a tool works or after it ended without a card. */
function Line({ text, working }: { text: string; working?: boolean }) {
  return (
    <p
      className={cn(
        "px-1 py-1.5 text-muted-foreground text-sm",
        working && "shimmer motion-reduce:animate-none"
      )}
      role={working ? "status" : undefined}
    >
      {text}
    </p>
  )
}

export const FindDomain: ToolCallMessagePartComponent = (props) => {
  const aui = useAui()
  const running = useAuiState((s) => s.thread.isRunning)
  const streaming = useAuiState((s) => s.message.status?.type === "running")
  const [chosen, setChosen] = useState<string | null>(null)
  const view = readView(props, FindDomainOutput)
  const id = useId()

  if (view.state !== "done") {
    return (
      <div data-slot="find-domain">
        <Line
          text={
            view.state === "working" && streaming
              ? "Looking for a free name"
              : view.state === "failed"
                ? "Could not look for a name"
                : "Stopped looking for a name"
          }
          working={view.state === "working" && streaming}
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

  const { best } = view.output
  const others = view.output.options
    .filter((offer) => offer.name !== best.name)
    .slice(0, 3)
  const choose = (name: string) => {
    setChosen(name)
    aui.thread().append(chooseText(name))
  }

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="my-3 flex max-w-md flex-col"
      data-slot="find-domain"
    >
      <h3 className={META} id={`${id}-title`}>
        Free to register now
      </h3>
      <div className="flex flex-col divide-y divide-border">
        {[best, ...others].map((offer) => (
          <Offer
            best={offer === best}
            disabled={running || chosen !== null}
            key={offer.name}
            offer={offer}
            onChoose={() => choose(offer.name)}
          />
        ))}
      </div>
      <p className={META}>
        Renews yearly at the same price. Nothing is charged until you pay.
      </p>
    </section>
  )
}
FindDomain.displayName = "FindDomain"

/* buy_domain ------------------------------------------------------------ */

const TYPES: Record<RegistrantType, string> = {
  STRA: "Sole trader",
  LTD: "Limited company",
  LLP: "Limited liability partnership",
  PTNR: "Partnership",
  IND: "Individual",
}

/** .co.uk and .uk need who the registrant is in law. */
const needsType = (name: string) => {
  const tld = sellableTld(name)
  return tld === "co.uk" || tld === "uk"
}

/** The details as one plain paragraph. */
function DetailsText({ details }: { details: RegistrantDetails }) {
  const { registrant: who, registrant_type: type } = details
  const address = who.address
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {who.organization ? (
        <>
          <dt className="text-muted-foreground">Business</dt>
          <dd className="min-w-0 break-words">
            {who.organization}
            {type ? `, ${TYPES[type].toLowerCase()}` : ""}
            {details.company_number ? ` (${details.company_number})` : ""}
          </dd>
        </>
      ) : null}
      <dt className="text-muted-foreground">Name</dt>
      <dd className="min-w-0 break-words">
        {who.name}
        {!who.organization && type ? `, ${TYPES[type].toLowerCase()}` : ""}
      </dd>
      <dt className="text-muted-foreground">Address</dt>
      <dd className="min-w-0 break-words">
        {[
          address.street,
          address.city,
          address.state,
          address.postal_code,
          address.country_code,
        ]
          .filter(Boolean)
          .join(", ")}
      </dd>
      <dt className="text-muted-foreground">Email</dt>
      <dd className="min-w-0 break-all">{who.email}</dd>
      <dt className="text-muted-foreground">Phone</dt>
      <dd className="min-w-0 break-words">{who.phone}</dd>
    </dl>
  )
}

const MESSAGES = {
  name: "Write your full name.",
  organization: "Write your business's name.",
  email: "Write an email address you read.",
  phone: "Write a phone number, such as 07700 900123.",
  street: "Write the street address.",
  city: "Write the town or city.",
  state: "Check the county.",
  postal_code: "Write the postcode.",
  country_code: "Write the two-letter country code, such as GB.",
  registrant_type: "Choose what kind of business this is.",
  company_number: "Write the 8-character Companies House number.",
} satisfies Record<string, string>

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
  | { ok: false; errors: Record<string, string> } {
  const type = field(data, "registrant_type") as RegistrantType | undefined
  const company = field(data, "company_number")?.replace(/\s/g, "")
  const phone = field(data, "phone")
  const candidate = {
    registrant: {
      name: field(data, "name"),
      organization: field(data, "organization"),
      email: field(data, "email"),
      phone: phone ? toE164(phone) : undefined,
      address: {
        street: field(data, "street"),
        city: field(data, "city"),
        state: field(data, "state"),
        postal_code: field(data, "postal_code")?.toUpperCase(),
        country_code: field(data, "country_code")?.toUpperCase(),
      },
    },
    registrant_type: type,
    company_number:
      type === "LTD" || type === "LLP" ? company?.toUpperCase() : undefined,
  }
  const errors: Record<string, string> = {}
  const parsed = RegistrantDetails.safeParse(candidate)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path.at(-1) ?? "")
      errors[key] ??=
        (MESSAGES as Record<string, string | undefined>)[key] ?? "Check this."
    }
  }
  if (needsType(name)) {
    if (!type) errors.registrant_type ??= MESSAGES.registrant_type
    if (type !== "IND" && !candidate.registrant.organization) {
      errors.organization ??= MESSAGES.organization
    }
  }
  if ((type === "LTD" || type === "LLP") && !candidate.company_number) {
    errors.company_number ??= MESSAGES.company_number
  }
  return parsed.success && Object.keys(errors).length === 0
    ? { ok: true, details: parsed.data }
    : { ok: false, errors }
}

/** The details form. Saving checks every field in place. */
function DetailsForm({
  name,
  details,
  onSave,
  onCancel,
}: {
  name: string
  details: RegistrantDetails
  onSave: (details: RegistrantDetails) => void
  onCancel: () => void
}) {
  const id = useId()
  const first = useRef<HTMLInputElement>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [type, setType] = useState(details.registrant_type)
  const who = details.registrant
  useEffect(() => first.current?.focus(), [])

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const read = readDetails(name, new FormData(event.currentTarget))
    if (read.ok) onSave(read.details)
    else setErrors(read.errors)
  }
  const text = (
    key: string,
    label: string,
    value: string | undefined,
    extra: Partial<ComponentProps<"input">> = {}
  ) => (
    <Field
      defaultValue={value}
      error={errors[key]}
      id={`${id}-${key}`}
      label={label}
      name={key}
      {...extra}
    />
  )

  return (
    <form
      aria-label="Registration details"
      className="flex flex-col gap-3"
      noValidate
      onSubmit={submit}
    >
      <Field
        autoComplete="name"
        defaultValue={who.name}
        error={errors.name}
        id={`${id}-name`}
        label="Your full name"
        name="name"
        ref={first}
      />
      {text("organization", "Business name", who.organization, {
        autoComplete: "organization",
      })}
      {needsType(name) ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm">Kind of business</legend>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(TYPES) as RegistrantType[]).map((each) => (
              <label
                className="flex min-h-9 cursor-pointer items-center gap-2 rounded-full border border-border px-3 text-sm has-[:checked]:border-primary has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring"
                key={each}
              >
                <input
                  className="accent-primary"
                  defaultChecked={type === each}
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
      {type === "LTD" || type === "LLP"
        ? text(
            "company_number",
            "Companies House number",
            details.company_number,
            {
              autoCapitalize: "characters",
              maxLength: 8,
            }
          )
        : null}
      {text("email", "Email", who.email, {
        autoComplete: "email",
        type: "email",
      })}
      {text("phone", "Phone", who.phone, { autoComplete: "tel", type: "tel" })}
      {text("street", "Street address", who.address.street, {
        autoComplete: "street-address",
      })}
      {text("city", "Town or city", who.address.city, {
        autoComplete: "address-level2",
      })}
      {text("state", "County (optional)", who.address.state, {
        autoComplete: "address-level1",
      })}
      {text("postal_code", "Postcode", who.address.postal_code, {
        autoComplete: "postal-code",
      })}
      {text("country_code", "Country code", who.address.country_code, {
        autoComplete: "country",
        maxLength: 2,
      })}
      <div className="flex gap-2">
        <Button size="sm" type="submit">
          Save details
        </Button>
        <Button onClick={onCancel} size="sm" type="button" variant="outline">
          Cancel
        </Button>
      </div>
    </form>
  )
}

/** Stripe's embedded Checkout, mounted while this is on screen. */
function Checkout({
  publishableKey,
  clientSecret,
}: {
  publishableKey: string
  clientSecret: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const element = host.current
    if (!element) return
    element.focus()
    let live = true
    let unmount: (() => void) | null = null
    mountCheckout(element, publishableKey, clientSecret).then(
      (done) => {
        if (live) unmount = done
        else done()
      },
      () => live && setFailed(true)
    )
    return () => {
      live = false
      unmount?.()
    }
  }, [publishableKey, clientSecret])
  return failed ? (
    <Problem text="The payment form did not load. Check your connection and try again." />
  ) : (
    // Focus moves here as the pay button gives way to it, so a keyboard
    // owner lands on the payment form rather than the page.
    <section
      aria-label="Payment"
      className="min-h-96 overflow-hidden rounded-2xl outline-none"
      data-slot="domain-checkout"
      ref={host}
      tabIndex={-1}
    />
  )
}

const STATUS_TEXT: Record<PurchaseStatus, (name: string) => string> = {
  authorised: (name) =>
    `Payment approved. I'm registering ${name} now and will message you when it's done.`,
  serving: (name) =>
    `${name} is registered to your business. Your website goes on it in the next few minutes.`,
  registered: (name) => `${name} is yours, and your website is on it.`,
  test: (name) =>
    `This was a test purchase: paid in test mode and registered in Cloudflare's sandbox. ${name} is not live on the internet, and no real money moved.`,
  failed: (name) =>
    `${name} could not be registered, so your card was not charged.`,
  price_changed: (name) =>
    `The price of ${name} went up before it could be registered, so your card was not charged. Ask me for a fresh price.`,
  unavailable: (name) =>
    `Someone registered ${name} first, so your card was not charged.`,
  abandoned: (name) =>
    `The payment for ${name} timed out before it was made. Ask me again if you still want it.`,
  removed: (name) => `${name} is yours, and no longer on your website.`,
}

const TICKED = new Set<PurchaseStatus>([
  "authorised",
  "serving",
  "registered",
  "test",
  "removed",
])

/** Statuses that change on their own, so the card reads them again. */
const MOVING = new Set<PurchaseStatus>(["authorised", "serving"])
const REREAD_MS = 5000

/**
 * The purchase's status, read when the card shows and again every few
 * seconds while registering. `undefined` until the first read answers; a
 * read that fails counts as none, and the api refuses a second payment.
 */
function usePurchaseStatus(
  purchase: DomainPurchase | null,
  name: string
): PurchaseStatus | null | undefined {
  const [status, setStatus] = useState<PurchaseStatus | null | undefined>(
    purchase ? undefined : null
  )
  useEffect(() => {
    if (!purchase) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      const next = await purchase
        .status(name)
        .then(purchaseStatusOf, () => null)
      if (!live) return
      setStatus(next)
      if (next && MOVING.has(next)) timer = setTimeout(read, REREAD_MS)
    }
    void read()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [purchase, name])
  return status
}

/** What the purchase card shows, by where the owner is in it. */
type Phase =
  | { at: "review" }
  | { at: "editing" }
  | { at: "starting" }
  | { at: "paying"; publishable_key: string; client_secret: string }
  | { at: "refused"; code: string | null }

function Purchase({
  name,
  price,
  initial,
}: {
  name: string
  price: number
  initial: RegistrantDetails
}) {
  const purchase = useContext(DomainPurchaseContext)
  const id = useId()
  const [details, setDetails] = useState(initial)
  const [phase, setPhase] = useState<Phase>({ at: "review" })
  const edit = useRef<HTMLButtonElement>(null)
  const status = usePurchaseStatus(purchase, name)

  if (status) {
    // A tick only for a purchase that went through, or a test one that did.
    const Icon = TICKED.has(status) ? CheckCircleIcon : null
    return (
      <section
        className="my-3 flex max-w-md flex-col gap-1"
        data-slot="buy-domain"
      >
        <h3 className="break-all font-medium">{name}</h3>
        <p className="flex items-start gap-2 text-sm" role="status">
          {Icon ? (
            <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
          ) : null}
          {STATUS_TEXT[status](name)}
        </p>
      </section>
    )
  }

  const pay = async () => {
    if (!purchase) {
      setPhase({ at: "refused", code: "domain.buy_unavailable" })
      return
    }
    setPhase({ at: "starting" })
    try {
      const started = await purchase.checkout(name, details)
      setPhase(
        started.outcome === "open"
          ? { at: "paying", ...started }
          : { at: "refused", code: started.code }
      )
    } catch {
      setPhase({ at: "refused", code: null })
    }
  }

  return (
    <section
      aria-labelledby={`${id}-title`}
      className={cn(CARD_SURFACE, "my-3 flex max-w-md flex-col gap-3")}
      data-slot="buy-domain"
    >
      <div className="flex flex-col gap-0.5">
        <h3 className="break-all font-medium" id={`${id}-title`}>
          {name}
        </h3>
        <p className="text-sm">{pounds(price)} for 1 year, renews yearly.</p>
      </div>
      {phase.at === "editing" ? (
        <DetailsForm
          details={details}
          name={name}
          onCancel={() => {
            setPhase({ at: "review" })
            requestAnimationFrame(() => edit.current?.focus())
          }}
          onSave={(saved) => {
            setDetails(saved)
            setPhase({ at: "review" })
            requestAnimationFrame(() => edit.current?.focus())
          }}
        />
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <p className={META}>Registered to your business</p>
            <DetailsText details={details} />
            {phase.at === "paying" ? null : (
              <div>
                <Button
                  className="-ms-2.5"
                  onClick={() => setPhase({ at: "editing" })}
                  ref={edit}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <PencilSimpleIcon aria-hidden />
                  Edit details
                </Button>
              </div>
            )}
          </div>
          <p className={META}>
            Hidden from public WHOIS where the registry allows. It's yours: you
            can move it away any time after 60 days. By paying you authorise
            Reme to register it in your business's name and accept the{" "}
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href={AGREEMENT}
              rel="noopener noreferrer"
              target="_blank"
            >
              Cloudflare Domain Registration Agreement
              <ArrowSquareOutIcon
                aria-hidden
                className="ms-0.5 inline size-3"
              />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>{" "}
            and{" "}
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href={ICANN}
              rel="noopener noreferrer"
              target="_blank"
            >
              ICANN registrant rights
              <ArrowSquareOutIcon
                aria-hidden
                className="ms-0.5 inline size-3"
              />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            .
          </p>
          {phase.at === "paying" ? (
            <Checkout
              clientSecret={phase.client_secret}
              publishableKey={phase.publishable_key}
            />
          ) : phase.at === "refused" ? (
            <>
              <div role="alert">
                <Problem
                  text={refusalText(
                    phase.code,
                    "The payment could not be started. Try again."
                  )}
                />
              </div>
              {phase.code === "domain.buy_unavailable" ? null : (
                <div>
                  <Button onClick={pay} size="sm" type="button">
                    Try again
                  </Button>
                </div>
              )}
            </>
          ) : (
            <div aria-busy={phase.at === "starting" || status === undefined}>
              {/* Not offered until the read says the purchase still waits. */}
              <Button
                disabled={phase.at === "starting" || status === undefined}
                onClick={pay}
                size="sm"
                type="button"
              >
                {phase.at === "starting"
                  ? "Opening payment"
                  : status === undefined
                    ? "Checking the purchase"
                    : `Continue to pay ${pounds(price)}`}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  )
}

export const BuyDomain: ToolCallMessagePartComponent = (props) => {
  const streaming = useAuiState((s) => s.message.status?.type === "running")
  const view = readView(props, BuyDomainOutput)
  const input = BuyDomainInput.safeParse(props.args).data

  if (view.state !== "done") {
    return (
      <div data-slot="buy-domain">
        <Line
          text={
            view.state === "working" && streaming
              ? "Getting the purchase ready"
              : view.state === "failed"
                ? "Could not get the purchase ready"
                : "Stopped getting the purchase ready"
          }
          working={view.state === "working" && streaming}
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
  if (!input) {
    return (
      <div data-slot="buy-domain">
        <Problem text="This did not come through whole. Ask again." />
      </div>
    )
  }
  const { name: _name, ...details } = input
  return (
    <Purchase
      initial={details}
      name={view.output.name}
      price={view.output.price_gbp}
    />
  )
}
BuyDomain.displayName = "BuyDomain"
