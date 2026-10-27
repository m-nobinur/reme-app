/**
 * Stripe.js, loaded from js.stripe.com on first use, as Stripe requires: it
 * is never bundled or self-hosted, so card data stays in Stripe's frames.
 * Only the calls the payment dialog makes on a Checkout Session in
 * `ui_mode: elements` are typed here, from @stripe/stripe-js 10's
 * `checkout.d.ts`, which is why there is no @stripe/stripe-js dependency.
 */

import { toHex } from "@workspace/ui/lib/colour"

/** The versioned script URL from Stripe's Checkout Sessions quickstart. */
export const STRIPE_JS = "https://js.stripe.com/endive/stripe.js"

/** The part of the Checkout Session the page shows. */
export type CheckoutSession = {
  currency: string
  minorUnitsAmountDivisor: number
  total: { total: { minorUnitsAmount: number } }
}

export type CheckoutContact = {
  name: string
  address: {
    country: string
    line1?: string
    city?: string
    postal_code?: string
    state?: string
  }
}

type Failed = { type: "error"; error: { message: string } }

export type CheckoutActions = {
  getSession: () => CheckoutSession
  confirm: (options: {
    redirect: "if_required"
    email?: string
    billingAddress?: CheckoutContact
    expressCheckoutConfirmEvent?: unknown
  }) => Promise<{ type: "success" } | Failed>
}

export type StripeElement = {
  mount: (element: HTMLElement) => void
  destroy: () => void
  on: (event: string, handler: (event: never) => void) => void
}

export type CheckoutSdk = {
  on: (event: "change", handler: (session: CheckoutSession) => void) => void
  loadActions: () => Promise<
    { type: "success"; actions: CheckoutActions } | Failed
  >
  createPaymentElement: (options: object) => StripeElement
  createExpressCheckoutElement: (options?: object) => StripeElement
}

type Stripe = {
  initCheckoutElementsSdk: (options: {
    clientSecret: string
    elementsOptions: { appearance: object }
    defaultValues: { email: string; billingAddress: CheckoutContact }
  }) => CheckoutSdk
}

type StripeGlobal = (publishableKey: string) => Stripe

let script: Promise<StripeGlobal> | null = null

/** The Stripe global, loading the script once per page. */
function stripeGlobal(): Promise<StripeGlobal> {
  const ready = (window as { Stripe?: StripeGlobal }).Stripe
  if (ready) return Promise.resolve(ready)
  script ??= new Promise<StripeGlobal>((resolve, reject) => {
    const tag = document.createElement("script")
    tag.src = STRIPE_JS
    tag.async = true
    tag.onload = () => {
      const loaded = (window as { Stripe?: StripeGlobal }).Stripe
      if (loaded) resolve(loaded)
      else reject(new Error("Stripe.js loaded without Stripe."))
    }
    tag.onerror = () => {
      // A failed load (offline, blocked) may be retried by the next mount.
      script = null
      tag.remove()
      reject(new Error("Stripe.js did not load."))
    }
    document.head.appendChild(tag)
  })
  return script
}

const instances = new Map<string, Stripe>()

/**
 * Checkout for a session's client secret, prefilled with what the owner
 * already gave so Stripe asks for neither again, and drawn in the page's
 * own colours, read from `element`, which sits where the form will.
 */
export async function initCheckout(
  element: HTMLElement,
  publishableKey: string,
  clientSecret: string,
  defaultValues: { email: string; billingAddress: CheckoutContact }
): Promise<CheckoutSdk> {
  const Stripe = await stripeGlobal()
  let stripe = instances.get(publishableKey)
  if (!stripe) {
    stripe = Stripe(publishableKey)
    instances.set(publishableKey, stripe)
  }
  return stripe.initCheckoutElementsSdk({
    clientSecret,
    elementsOptions: { appearance: appearanceOf(element) },
    defaultValues,
  })
}

/**
 * The total as the page shows it, "£12" or "£12.50". Stripe's confirm
 * refuses unless the page reads and shows the session's total, so the
 * amount on Pay is always Stripe's, never ours.
 */
export function totalOf(session: CheckoutSession): string {
  const amount =
    session.total.total.minorUnitsAmount / session.minorUnitsAmountDivisor
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: session.currency,
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  }).format(amount)
}

/**
 * A token's colour as `#rrggbb`. The tokens are oklch(), and this does not
 * count on Stripe's frames parsing that; a canvas pixel does the conversion.
 */
function colourOf(style: CSSStyleDeclaration, token: string) {
  const value = style.getPropertyValue(token).trim()
  const paint = document.createElement("canvas").getContext("2d")
  if (!paint || !value) return value
  paint.fillStyle = value
  paint.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0] = paint.getImageData(0, 0, 1, 1).data
  return toHex([r, g, b])
}

/**
 * Stripe's Appearance from the design tokens where the form sits, so the
 * fields match the dialog in light and dark. Read once at mount; a theme
 * switch while the dialog is open keeps the old colours until it reopens.
 */
function appearanceOf(element: HTMLElement) {
  const style = getComputedStyle(element)
  const colour = (token: string) => colourOf(style, token)
  const dark = element.closest(".dark") !== null
  return {
    theme: dark ? "night" : "stripe",
    variables: {
      colorPrimary: colour("--primary"),
      colorBackground: colour("--popover"),
      colorText: colour("--popover-foreground"),
      colorTextSecondary: colour("--muted-foreground"),
      colorDanger: colour("--destructive"),
      fontFamily: style.fontFamily,
      fontSizeBase: "14px",
      borderRadius: "10px",
    },
    // The tray's own fields: a quiet edge, and the accent ring in focus.
    rules: {
      ".Input, .Tab": {
        border: `1px solid ${colour("--border")}`,
        boxShadow: "none",
      },
      ".Input:focus, .Tab:focus": {
        border: `1px solid ${colour("--primary")}`,
        boxShadow: `0 0 0 3px ${colour("--primary")}`,
      },
    },
  }
}
