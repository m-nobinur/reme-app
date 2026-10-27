// @vitest-environment happy-dom
import { initCheckout, STRIPE_JS, totalOf } from "@workspace/ui/lib/stripe"
import { expect, it, vi } from "vitest"

const PREFILL = {
  email: "jane@sparkle.example",
  billingAddress: {
    name: "Jane Smith",
    address: { country: "GB", line1: "12 Mill Lane", city: "Bristol" },
  },
}

it("loads Stripe.js from js.stripe.com once and starts Checkout prefilled", async () => {
  const sdk = {}
  const initCheckoutElementsSdk = vi.fn(() => sdk)
  const Stripe = vi.fn(() => ({ initCheckoutElementsSdk }))
  const element = document.createElement("div")
  // Kept off the page: the test plays the network's part.
  const added = vi
    .spyOn(document.head, "appendChild")
    .mockImplementation((node) => node)

  const first = initCheckout(element, "pk_test_1", "cs_test_1", PREFILL)
  await vi.waitFor(() => expect(added).toHaveBeenCalled())
  const script = added.mock.calls[0]?.[0] as HTMLScriptElement | undefined
  expect(script?.src).toBe(STRIPE_JS)
  ;(window as { Stripe?: unknown }).Stripe = Stripe
  script?.onload?.(new Event("load"))
  expect(await first).toBe(sdk)
  expect(initCheckoutElementsSdk).toHaveBeenCalledWith(
    expect.objectContaining({
      clientSecret: "cs_test_1",
      defaultValues: PREFILL,
      elementsOptions: { appearance: expect.objectContaining({}) },
    })
  )

  // A second Pay reuses the script and the Stripe instance.
  await initCheckout(element, "pk_test_1", "cs_test_2", PREFILL)
  expect(Stripe).toHaveBeenCalledOnce()
  expect(added).toHaveBeenCalledOnce()
  expect(initCheckoutElementsSdk).toHaveBeenCalledTimes(2)
})

it("shows Stripe's total in pounds, with pence only when there are some", () => {
  const session = (minor: number) => ({
    currency: "gbp",
    minorUnitsAmountDivisor: 100,
    total: { total: { minorUnitsAmount: minor } },
  })
  expect(totalOf(session(1200))).toBe("£12")
  expect(totalOf(session(1250))).toBe("£12.50")
})
