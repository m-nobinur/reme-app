/**
 * Stripe.js, loaded from js.stripe.com on first use, as Stripe requires: it
 * is never bundled or self-hosted, so card data stays in Stripe's frames.
 * Only the calls embedded Checkout needs are typed here, which is why there
 * is no @stripe/stripe-js dependency.
 */

/** The versioned script URL from Stripe's embedded Checkout quickstart. */
export const STRIPE_JS = "https://js.stripe.com/endive/stripe.js"

export type EmbeddedCheckout = {
  mount: (element: HTMLElement) => void
  destroy: () => void
}

type Stripe = {
  createEmbeddedCheckoutPage: (options: {
    fetchClientSecret: () => Promise<string>
  }) => Promise<EmbeddedCheckout>
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

// Stripe allows one embedded Checkout on a page at a time.
let current: EmbeddedCheckout | null = null

/**
 * Mounts embedded Checkout in `element` and returns what unmounts it. Any
 * Checkout already on the page is destroyed first.
 */
export async function mountCheckout(
  element: HTMLElement,
  publishableKey: string,
  clientSecret: string
): Promise<() => void> {
  const Stripe = await stripeGlobal()
  let stripe = instances.get(publishableKey)
  if (!stripe) {
    stripe = Stripe(publishableKey)
    instances.set(publishableKey, stripe)
  }
  current?.destroy()
  current = null
  const checkout = await stripe.createEmbeddedCheckoutPage({
    fetchClientSecret: async () => clientSecret,
  })
  current = checkout
  checkout.mount(element)
  return () => {
    if (current === checkout) current = null
    checkout.destroy()
  }
}
