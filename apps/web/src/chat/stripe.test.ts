// @vitest-environment happy-dom
import { mountCheckout, STRIPE_JS } from "@workspace/ui/lib/stripe"
import { expect, it, vi } from "vitest"

it("loads Stripe.js from js.stripe.com once and keeps one Checkout on the page", async () => {
  const made: {
    mount: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
  }[] = []
  const Stripe = vi.fn(() => ({
    createEmbeddedCheckoutPage: vi.fn(
      async ({
        fetchClientSecret,
        onComplete,
      }: {
        fetchClientSecret: () => Promise<string>
        onComplete?: () => void
      }) => {
        expect(await fetchClientSecret()).toMatch(/^cs_test_/)
        expect(onComplete).toBe(done)
        const checkout = { mount: vi.fn(), destroy: vi.fn() }
        made.push(checkout)
        return checkout
      }
    ),
  }))
  const element = document.createElement("div")
  const done = () => undefined
  // Kept off the page: the test plays the network's part.
  const added = vi
    .spyOn(document.head, "appendChild")
    .mockImplementation((node) => node)

  const first = mountCheckout(element, "pk_test_1", "cs_test_1", done)
  await vi.waitFor(() => expect(added).toHaveBeenCalled())
  const script = added.mock.calls[0]?.[0] as HTMLScriptElement | undefined
  expect(script?.src).toBe(STRIPE_JS)
  ;(window as { Stripe?: unknown }).Stripe = Stripe
  script?.onload?.(new Event("load"))
  const unmountFirst = await first
  expect(made[0]?.mount).toHaveBeenCalledWith(element)

  // A second Checkout replaces the first, with the same Stripe instance.
  const unmountSecond = await mountCheckout(
    element,
    "pk_test_1",
    "cs_test_2",
    done
  )
  expect(made[0]?.destroy).toHaveBeenCalledOnce()
  expect(Stripe).toHaveBeenCalledOnce()
  expect(added).toHaveBeenCalledOnce()

  // The first card's late unmount leaves the second Checkout alone.
  unmountFirst()
  expect(made[1]?.destroy).not.toHaveBeenCalled()
  unmountSecond()
  expect(made[1]?.destroy).toHaveBeenCalledOnce()
})

it("mounts overlapping Checkouts one after the other, as Stripe allows one", async () => {
  const open = new Set<object>()
  const Stripe = vi.fn(() => ({
    createEmbeddedCheckoutPage: vi.fn(async () => {
      await Promise.resolve()
      if (open.size > 0) throw new Error("multiple embedded Checkouts")
      const checkout = {
        mount: vi.fn(),
        destroy: vi.fn(() => open.delete(checkout)),
      }
      open.add(checkout)
      return checkout
    }),
  }))
  ;(window as { Stripe?: unknown }).Stripe = Stripe
  const element = document.createElement("div")
  // React's dev double effect: mount, unmount before it resolves, mount again.
  const first = mountCheckout(
    element,
    "pk_test_2",
    "cs_test_3",
    () => undefined
  )
  const second = mountCheckout(
    element,
    "pk_test_2",
    "cs_test_4",
    () => undefined
  )
  void first.then((done) => done())
  const unmount = await second
  expect(open.size).toBe(1)
  unmount()
  expect(open.size).toBe(0)
})
