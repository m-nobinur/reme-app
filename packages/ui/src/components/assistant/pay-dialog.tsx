import { CaretDownIcon, LockSimpleIcon } from "@phosphor-icons/react"
import type { Registrant } from "@workspace/contracts"
import { Problem } from "@workspace/ui/components/assistant/decision"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { SubmitButton } from "@workspace/ui/components/submit-button"
import {
  type CheckoutActions,
  type CheckoutContact,
  initCheckout,
  type StripeElement,
  totalOf,
} from "@workspace/ui/lib/stripe"
import { cn, META } from "@workspace/ui/lib/utils"
import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react"

/**
 * Paying for a domain: the order on the left, Stripe's Express Checkout
 * (Link, Apple Pay, Google Pay) and card form on the right, on the purchase's
 * Checkout Session. The billing address goes to Stripe from the registrant,
 * and the email through the Stripe Customer the api sets, so Stripe asks
 * for neither. Narrow, the order folds to one line above the form.
 */
export function PayDialog({
  name,
  priceGbp,
  publishableKey,
  clientSecret,
  registrant,
  onPaid,
  onClose,
}: {
  name: string
  /** The yearly price, which is also what the renewal charges. */
  priceGbp: number
  publishableKey: string
  clientSecret: string
  registrant: Registrant
  /** The payment went through on the page. */
  onPaid: () => void
  /** Closed unpaid. */
  onClose: () => void
}) {
  // Stripe's own total once the session loads, ours until then.
  const [total, setTotal] = useState<string | null>(null)
  const today = total ?? `£${priceGbp}`
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      open
    >
      <DialogContent className="gap-0 p-0 sm:max-w-3xl md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <OrderSummary name={name} priceGbp={priceGbp} today={today} />
        <section className="flex flex-col gap-5 p-6">
          <DialogHeader>
            <DialogTitle>Payment details</DialogTitle>
          </DialogHeader>
          <PaymentForm
            clientSecret={clientSecret}
            onPaid={onPaid}
            onTotal={setTotal}
            publishableKey={publishableKey}
            registrant={registrant}
            today={today}
          />
        </section>
      </DialogContent>
    </Dialog>
  )
}

const NEXT = [
  ["Today", "You pay and we register it."],
  ["Within an hour", "It points at your website."],
  ["In a year", "We renew it and email you first."],
] as const

function OrderSummary({
  name,
  priceGbp,
  today,
}: {
  name: string
  priceGbp: number
  today: string
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  return (
    <aside
      aria-label="Your order"
      className="flex flex-col gap-4 bg-rail p-6 text-rail-foreground"
    >
      <button
        aria-controls={id}
        aria-expanded={open}
        className="-m-2 flex items-center justify-between gap-3 rounded-lg p-2 text-start outline-none focus-visible:ring-2 focus-visible:ring-primary md:hidden"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <span className="min-w-0 truncate font-medium">{name}, 1 year</span>
        <span className="flex shrink-0 items-center gap-1.5 font-medium tabular-nums">
          {today}
          <CaretDownIcon
            aria-hidden
            className={cn(
              "size-4 transition-transform duration-150 motion-reduce:transition-none",
              open && "rotate-180"
            )}
          />
          <span className="sr-only">{open ? "Hide" : "Show"} the order</span>
        </span>
      </button>
      <div
        className={cn("flex-col gap-6", open ? "flex" : "hidden md:flex")}
        id={id}
      >
        <h2 className="hidden font-heading font-medium text-base leading-none md:block">
          Your order
        </h2>
        <div className="flex flex-col gap-4">
          <dl className="flex flex-col gap-2">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Domain</dt>
              <dd className="min-w-0 break-all text-end font-medium">{name}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Length</dt>
              <dd className="font-medium">1 year</dd>
            </div>
          </dl>
          <hr className="border-border" />
          <div className="flex flex-col gap-1">
            <p className="flex items-baseline justify-between gap-4">
              <span className="font-medium">Today's total</span>
              <span className="font-semibold text-lg text-primary tabular-nums">
                {today}
              </span>
            </p>
            <p className={META}>
              Renews at £{priceGbp} a year, cancel any time.
            </p>
          </div>
        </div>
        <section className="flex flex-col gap-3">
          <h3 className="font-medium">What happens next</h3>
          <ol>
            {NEXT.map(([when, what], index) => (
              <li className="relative flex gap-3 pb-4 last:pb-0" key={when}>
                {index < NEXT.length - 1 ? (
                  <span
                    aria-hidden
                    className="absolute top-4 bottom-0 left-[3.5px] w-px bg-border"
                  />
                ) : null}
                <span
                  aria-hidden
                  className={cn(
                    "mt-1.5 size-2 shrink-0 rounded-full",
                    index === 0
                      ? "bg-primary"
                      : "border border-muted-foreground bg-rail"
                  )}
                />
                <span className="flex flex-col">
                  <span className="font-medium">{when}</span>
                  <span className={META}>{what}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </aside>
  )
}

/** The registrant as Stripe's billing contact. */
const contactOf = ({ name, address }: Registrant): CheckoutContact => ({
  name,
  address: {
    country: address.country_code,
    line1: address.street,
    city: address.city,
    postal_code: address.postal_code,
    ...(address.state ? { state: address.state } : {}),
  },
})

type Confirmed = Awaited<ReturnType<CheckoutActions["confirm"]>>

function PaymentForm({
  publishableKey,
  clientSecret,
  registrant,
  today,
  onTotal,
  onPaid,
}: {
  publishableKey: string
  clientSecret: string
  registrant: Registrant
  today: string
  onTotal: (total: string) => void
  onPaid: () => void
}) {
  const wallets = useRef<HTMLDivElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const actions = useRef<CheckoutActions | null>(null)
  const paid = useRef(onPaid)
  paid.current = onPaid
  const [state, setState] = useState<"loading" | "ready" | "paying" | "failed">(
    "loading"
  )
  const [walletState, setWallets] = useState<"loading" | "shown" | "none">(
    "loading"
  )
  const [error, setError] = useState<string | null>(null)

  // Both ways to pay end here: paid closes the dialog, anything else is said
  // under Pay and leaves the form to try again.
  const settle = useCallback((result: Confirmed) => {
    if (result.type === "success") paid.current()
    else {
      setError(result.error.message)
      setState("ready")
    }
  }, [])

  useEffect(() => {
    const top = wallets.current
    const form = card.current
    if (!top || !form) return
    let live = true
    const mounted: StripeElement[] = []
    const contact = contactOf(registrant)
    initCheckout(form, publishableKey, clientSecret, {
      billingAddress: contact,
    })
      .then(async (checkout) => {
        if (!live) return
        checkout.on("change", (session) => live && onTotal(totalOf(session)))
        const express = checkout.createExpressCheckoutElement()
        express.on(
          "ready",
          (event: { availablePaymentMethods?: object | undefined }) =>
            live && setWallets(event.availablePaymentMethods ? "shown" : "none")
        )
        // Wallets are a shortcut: if they fail, the card form still pays.
        express.on("loaderror", () => live && setWallets("none"))
        express.on("confirm", async (event: unknown) => {
          const ready = actions.current
          if (!ready) return
          setError(null)
          settle(
            await ready.confirm({
              redirect: "if_required",
              expressCheckoutConfirmEvent: event,
            })
          )
        })
        // The address is the registrant's, given to Stripe at init and on
        // confirm, so the card form asks for the card alone.
        const payment = checkout.createPaymentElement({
          fields: { billingDetails: { address: "never" } },
        })
        payment.on("loaderror", () => live && setState("failed"))
        mounted.push(express, payment)
        express.mount(top)
        payment.mount(form)
        const loaded = await checkout.loadActions()
        if (!live) return
        if (loaded.type === "error") throw new Error(loaded.error.message)
        actions.current = loaded.actions
        onTotal(totalOf(loaded.actions.getSession()))
        setState("ready")
      })
      .catch(() => live && setState("failed"))
    return () => {
      live = false
      actions.current = null
      for (const element of mounted) element.destroy()
    }
  }, [publishableKey, clientSecret, registrant, onTotal, settle])

  const pay = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const ready = actions.current
    if (!ready || state !== "ready") return
    setError(null)
    setState("paying")
    settle(
      await ready.confirm({
        redirect: "if_required",
        billingAddress: contactOf(registrant),
      })
    )
  }

  if (state === "failed") {
    return (
      <div role="alert">
        <Problem text="The payment form did not load. Check your connection and try again." />
      </div>
    )
  }
  return (
    <form
      aria-label="Payment"
      className="flex flex-col gap-4"
      noValidate
      onSubmit={pay}
    >
      <div
        data-slot="domain-wallets"
        hidden={walletState === "none"}
        ref={wallets}
      />
      {walletState === "shown" ? (
        <p className={cn(META, "flex items-center gap-3")}>
          <span aria-hidden className="h-px flex-1 bg-border" />
          Or pay by card
          <span aria-hidden className="h-px flex-1 bg-border" />
        </p>
      ) : null}
      <div className="min-h-40" data-slot="domain-card" ref={card} />
      <div className="flex flex-col gap-2">
        <SubmitButton
          pending={state !== "ready"}
          pendingLabel={state === "paying" ? "Paying" : "Loading"}
        >
          Pay {today}
        </SubmitButton>
        {error ? (
          <div role="alert">
            <Problem text={error} />
          </div>
        ) : null}
        <p className={cn(META, "flex items-center justify-center gap-1.5")}>
          <LockSimpleIcon aria-hidden className="size-3.5" />
          Paid securely through Stripe. We never see your card number.
        </p>
      </div>
    </form>
  )
}
