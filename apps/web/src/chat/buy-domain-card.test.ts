// @vitest-environment happy-dom

import type { DomainPurchaseStatus } from "@workspace/contracts"
import { Approval } from "@workspace/ui/components/assistant/approval"
import {
  type CheckoutStart,
  chooseText,
  type DomainPurchase,
  DomainPurchaseProvider,
  purchaseStatusOf,
  readDetails,
} from "@workspace/ui/components/assistant/buy-domain"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

// The cards read the thread through assistant-ui's store; these tests stand in
// for it, since what they check is the card, not the runtime.
const store = vi.hoisted(() => ({
  isRunning: false,
  append: vi.fn(),
}))
vi.mock("@assistant-ui/react", async (original) => ({
  ...(await original<typeof import("@assistant-ui/react")>()),
  useAuiState: (select: (state: unknown) => unknown) =>
    select({
      message: { parts: [], isLast: true, status: undefined },
      thread: { isRunning: store.isRunning },
    }),
  useAui: () => ({ thread: () => ({ append: store.append }) }),
  useThreadViewport: () => undefined,
}))

// Stripe.js is Stripe's to load; the card's part is mounting it with the
// client secret the api returned.
const stripe = vi.hoisted(() => ({
  mount: vi.fn(async () => stripe.unmount),
  unmount: vi.fn(),
}))
vi.mock("@workspace/ui/lib/stripe", () => ({ mountCheckout: stripe.mount }))

const NAME = "sparkleclean.co.uk"
const REGISTRANT = {
  name: "Jane Smith",
  organization: "Sparkle Clean",
  email: "jane@sparkle.example",
  phone: "+447700900123",
  address: {
    street: "12 Mill Lane",
    city: "Bristol",
    postal_code: "BS1 4AB",
    country_code: "GB",
  },
}
const BUY = { name: NAME, registrant: REGISTRANT, registrant_type: "STRA" }
const AWAITING = {
  outcome: "awaiting_payment",
  name: NAME,
  price_gbp: 8,
  checkout: "embedded",
}
const offer = (name: string, price: number) => ({
  name,
  price_gbp_year: price,
  why: `Why ${name}`,
})
const FOUND = {
  outcome: "found",
  best: offer(NAME, 8),
  options: [
    offer("sparklecleanbristol.co.uk", 8),
    offer("sparkleclean.uk", 8),
    offer("sparklecleanbristol.com", 12),
    offer("sparkle-clean.com", 12),
  ],
}

type Props = Record<string, unknown>

/** Draws a CoS tool part as the thread does, inside the app's buy provider. */
async function draw(
  toolName: string,
  props: Props,
  purchase: DomainPurchase | null = null
) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  const part = createElement(Approval, {
    toolName,
    toolCallId: "call-1",
    argsText: "",
    respondToApproval: vi.fn(),
    ...props,
  } as never)
  await act(async () =>
    root.render(
      purchase
        ? createElement(DomainPurchaseProvider, { value: purchase }, part)
        : part
    )
  )
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}

type Read = Omit<DomainPurchaseStatus, "name">

const purchaseOf = (start: CheckoutStart, read: Read | null = null) => ({
  checkout: vi.fn(async () => start),
  status: vi.fn(async () => (read ? { name: NAME, ...read } : null)),
})

const buttons = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].map((b) => b.textContent?.trim())

const press = async (container: HTMLElement, label: string) => {
  const button = [...container.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === label
  )
  if (!button) throw new Error(`no ${label} button`)
  await act(async () => button.click())
}

afterEach(() => {
  store.isRunning = false
  store.append.mockReset()
  stripe.mount.mockClear()
  stripe.unmount.mockClear()
})

it("offers the best name and three others at their GBP price, each one choosable", async () => {
  const card = await draw("find_domain", { args: {}, result: FOUND })
  const text = card.container.textContent ?? ""
  expect(text).toContain("£8 a year")
  expect(text).toContain("£12 a year")
  const choose = [...card.container.querySelectorAll("button")]
  // The best pick once, then three others: the fourth other is left out.
  expect(choose.map((b) => b.getAttribute("aria-label"))).toEqual([
    `Choose ${NAME}`,
    "Choose sparklecleanbristol.co.uk",
    "Choose sparkleclean.uk",
    "Choose sparklecleanbristol.com",
  ])
  await act(async () => choose[2]?.click())
  expect(store.append).toHaveBeenCalledWith(chooseText("sparkleclean.uk"))
  // One choice per card: the buttons wait for the assistant's answer.
  expect(choose.every((b) => b.disabled)).toBe(true)
  await card.unmount()
})

it("lets nobody choose while the assistant is answering", async () => {
  store.isRunning = true
  const card = await draw("find_domain", { args: {}, result: FOUND })
  expect(
    [...card.container.querySelectorAll("button")].every((b) => b.disabled)
  ).toBe(true)
  await card.unmount()
})

it("says plainly when no name was free", async () => {
  const card = await draw("find_domain", {
    args: {},
    result: {
      outcome: "refused",
      error: {
        class: "resource",
        code: "domain.unavailable",
        message: "That name isn't free to register.",
      },
    },
  })
  expect(card.container.textContent).toContain(
    "None of the names I tried are free."
  )
  expect(buttons(card.container)).toEqual([])
  await card.unmount()
})

it("shows what is bought, for how much, in whose name, and the agreements", async () => {
  const card = await draw("buy_domain", { args: BUY, result: AWAITING })
  const text = card.container.textContent ?? ""
  expect(card.container.querySelector("h3")?.textContent).toBe(NAME)
  expect(text).toContain("£8 for 1 year, renews yearly.")
  expect(text).toContain("Sparkle Clean, sole trader")
  expect(text).toContain("Jane Smith")
  expect(text).toContain("12 Mill Lane, Bristol, BS1 4AB, GB")
  const links = [...card.container.querySelectorAll("a")].map((a) => [
    a.getAttribute("href"),
    a.getAttribute("target"),
  ])
  expect(links).toEqual([
    ["https://www.cloudflare.com/domain-registration-agreement", "_blank"],
    ["https://www.icann.org/resources/pages/benefits-2013-09-16-en", "_blank"],
  ])
  expect(buttons(card.container)).toEqual([
    "Edit details",
    "Continue to pay £8",
  ])
  await card.unmount()
})

it("mounts Checkout with the client secret the api returned for the details shown", async () => {
  const purchase = purchaseOf({
    outcome: "open",
    publishable_key: "pk_test_1",
    client_secret: "cs_x",
  })
  const card = await draw(
    "buy_domain",
    { args: BUY, result: AWAITING },
    purchase
  )
  await press(card.container, "Continue to pay £8")
  expect(purchase.checkout).toHaveBeenCalledWith(NAME, {
    registrant: REGISTRANT,
    registrant_type: "STRA",
  })
  expect(stripe.mount).toHaveBeenCalledWith(
    card.container.querySelector("[data-slot=domain-checkout]"),
    "pk_test_1",
    "cs_x"
  )
  // A keyboard owner lands on the payment form, not the page.
  expect(document.activeElement?.getAttribute("data-slot")).toBe(
    "domain-checkout"
  )
  // Paying is under way: the details are fixed in this Checkout.
  expect(buttons(card.container)).toEqual([])
  await card.unmount()
  expect(stripe.unmount).toHaveBeenCalledOnce()
})

it("says buying is off, with nothing to retry, when the app has no Checkout", async () => {
  const card = await draw("buy_domain", { args: BUY, result: AWAITING })
  await press(card.container, "Continue to pay £8")
  expect(card.container.textContent).toContain(
    "Buying a domain isn't available yet."
  )
  expect(buttons(card.container)).toEqual(["Edit details"])
  expect(stripe.mount).not.toHaveBeenCalled()
  await card.unmount()
})

it("reads a refusal by its code and offers to try again", async () => {
  const purchase = purchaseOf({
    outcome: "refused",
    code: "domain.price_changed",
  })
  const card = await draw(
    "buy_domain",
    { args: BUY, result: AWAITING },
    purchase
  )
  await press(card.container, "Continue to pay £8")
  expect(card.container.querySelector("[role=alert]")?.textContent).toContain(
    "That domain's price has changed, so nothing was charged."
  )
  expect(buttons(card.container)).toEqual(["Edit details", "Try again"])
  await card.unmount()
})

it("lets the owner correct the details before paying, and pays with the corrected ones", async () => {
  const purchase = purchaseOf({
    outcome: "open",
    publishable_key: "pk_test_1",
    client_secret: "cs_x",
  })
  const card = await draw(
    "buy_domain",
    { args: BUY, result: AWAITING },
    purchase
  )
  await press(card.container, "Edit details")
  const form = card.container.querySelector("form")
  if (!form) throw new Error("no form")
  // The first field takes focus, so a keyboard owner starts typing there.
  expect(document.activeElement?.getAttribute("name")).toBe("name")
  const input = (name: string) =>
    form.querySelector<HTMLInputElement>(`[name=${name}]`) as HTMLInputElement
  input("name").value = "Jane A. Smith"
  input("phone").value = "07700 900456"
  await act(async () => form.requestSubmit())
  expect(card.container.textContent).toContain("Jane A. Smith")
  // Back on the summary, focus returns to the button that opened the form.
  await act(
    async () => new Promise<void>((done) => requestAnimationFrame(() => done()))
  )
  expect(document.activeElement?.textContent).toContain("Edit details")
  await press(card.container, "Continue to pay £8")
  expect(purchase.checkout).toHaveBeenCalledWith(NAME, {
    registrant: {
      ...REGISTRANT,
      name: "Jane A. Smith",
      phone: "+447700900456",
    },
    registrant_type: "STRA",
  })
  await card.unmount()
})

it("keeps the form open and says what is wrong when a field does not read", async () => {
  const card = await draw("buy_domain", { args: BUY, result: AWAITING })
  await press(card.container, "Edit details")
  const form = card.container.querySelector("form") as HTMLFormElement
  ;(form.querySelector("[name=email]") as HTMLInputElement).value = "jane"
  await act(async () => form.requestSubmit())
  const email = form.querySelector("[name=email]")
  expect(email?.getAttribute("aria-invalid")).toBe("true")
  expect(card.container.textContent).toContain(
    "Write an email address you read."
  )
  await card.unmount()
})

it.each([
  [
    "authorised",
    { state: "verifying", test: false },
    "Payment approved. I'm registering",
  ],
  [
    "registered",
    { state: "active", test: false, outcome: "registered" },
    `${NAME} is yours, and your website is on it.`,
  ],
  [
    "test",
    { state: "verifying", test: true, outcome: "test_registered" },
    "This was a test purchase",
  ],
  [
    "failed",
    { state: "failed", test: false, outcome: "payment_released" },
    "could not be registered, so your card was not charged",
  ],
  [
    "abandoned",
    { state: "abandoned", test: false, outcome: "expired" },
    "timed out before it was made",
  ],
] as const)(
  "shows a %s purchase as such, with no way to pay again",
  async (status, read, line) => {
    const purchase = purchaseOf({ outcome: "refused", code: null }, read)
    const card = await draw(
      "buy_domain",
      { args: BUY, result: AWAITING },
      purchase
    )
    expect(card.container.textContent).toContain(line)
    expect(buttons(card.container)).toEqual([])
    expect(purchase.status).toHaveBeenCalledWith(NAME)
    // A tick only where the purchase went through.
    expect(card.container.querySelector("svg") !== null).toBe(
      status !== "failed" && status !== "abandoned"
    )
    await card.unmount()
  }
)

it("offers no payment until the read says the purchase still waits on one", async () => {
  let answer: (read: null) => void = () => undefined
  const purchase = {
    checkout: vi.fn(),
    status: vi.fn(() => new Promise<null>((resolve) => (answer = resolve))),
  }
  const card = await draw(
    "buy_domain",
    { args: BUY, result: AWAITING },
    purchase
  )
  const pay = () =>
    [...card.container.querySelectorAll("button")].find(
      (b) =>
        b.textContent?.includes("pay") || b.textContent?.includes("Checking")
    )
  expect(pay()?.textContent).toBe("Checking the purchase")
  expect(pay()?.disabled).toBe(true)
  await act(async () => answer(null))
  expect(pay()?.textContent).toBe("Continue to pay £8")
  expect(pay()?.disabled).toBe(false)
  await card.unmount()
})

it("reads a registering purchase again until it settles", async () => {
  vi.useFakeTimers()
  const reads: Read[] = [
    { state: "verifying", test: false },
    { state: "verifying", test: false, outcome: "registered" },
    { state: "active", test: false, outcome: "registered" },
  ]
  const purchase = {
    checkout: vi.fn(),
    status: vi.fn(async () => ({ name: NAME, ...(reads.shift() as Read) })),
  }
  const card = await draw(
    "buy_domain",
    { args: BUY, result: AWAITING },
    purchase
  )
  expect(card.container.textContent).toContain("Payment approved.")
  await act(async () => vi.advanceTimersByTimeAsync(5000))
  expect(card.container.textContent).toContain("Your website goes on it")
  await act(async () => vi.advanceTimersByTimeAsync(5000))
  expect(card.container.textContent).toContain("your website is on it.")
  // Settled: no more reads.
  await act(async () => vi.advanceTimersByTimeAsync(20000))
  expect(purchase.status).toHaveBeenCalledTimes(3)
  vi.useRealTimers()
  await card.unmount()
})

it("reads every purchase outcome in the card's words", () => {
  const of = (read: Read) => purchaseStatusOf({ name: NAME, ...read })
  expect(purchaseStatusOf(null)).toBeNull()
  expect(of({ state: "awaiting_payment", test: false })).toBeNull()
  expect(of({ state: "verifying", test: true })).toBe("authorised")
  expect(of({ state: "active", test: true })).toBe("test")
  expect(of({ state: "failed", test: false, outcome: "price_changed" })).toBe(
    "price_changed"
  )
  expect(of({ state: "failed", test: false, outcome: "unavailable" })).toBe(
    "unavailable"
  )
  expect(of({ state: "removed", test: false, outcome: "registered" })).toBe(
    "removed"
  )
  expect(of({ state: "abandoned", test: false })).toBe("abandoned")
})

const form = (fields: Record<string, string>) => {
  const data = new FormData()
  for (const [key, value] of Object.entries(fields)) data.set(key, value)
  return data
}
const FIELDS = {
  name: "Jane Smith",
  organization: "Sparkle Clean",
  email: "jane@sparkle.example",
  phone: "07700 900123",
  street: "12 Mill Lane",
  city: "Bristol",
  postal_code: "bs1 4ab",
  country_code: "gb",
}

it("asks a .co.uk for who the registrant is in law, and a company for its number", () => {
  expect(readDetails(NAME, form(FIELDS))).toEqual({
    ok: false,
    errors: { registrant_type: "Choose what kind of business this is." },
  })
  // A .com needs neither.
  expect(readDetails("sparkleclean.com", form(FIELDS))).toMatchObject({
    ok: true,
  })
  expect(
    readDetails(NAME, form({ ...FIELDS, registrant_type: "LTD" }))
  ).toEqual({
    ok: false,
    errors: {
      company_number: "Write the 8-character Companies House number.",
    },
  })
  expect(
    readDetails(
      NAME,
      form({ ...FIELDS, registrant_type: "LTD", company_number: "sc12 3456" })
    )
  ).toEqual({
    ok: true,
    details: {
      registrant: {
        ...REGISTRANT,
        address: { ...REGISTRANT.address, postal_code: "BS1 4AB" },
      },
      registrant_type: "LTD",
      company_number: "SC123456",
    },
  })
  // A sole trader's company number is not sent.
  expect(
    readDetails(
      NAME,
      form({ ...FIELDS, registrant_type: "STRA", company_number: "SC123456" })
    )
  ).toMatchObject({ ok: true, details: { company_number: undefined } })
})
