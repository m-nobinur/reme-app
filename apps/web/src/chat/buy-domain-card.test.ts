// @vitest-environment happy-dom

import type {
  DomainPurchaseStatus,
  DomainRegistrantPrefill,
} from "@workspace/contracts"
import { Approval } from "@workspace/ui/components/assistant/approval"
import {
  type CheckoutStart,
  type DomainPurchase,
  DomainPurchaseProvider,
  purchaseStatusOf,
  readDetails,
} from "@workspace/ui/components/assistant/buy-domain"
import { TraySlotProvider } from "@workspace/ui/components/assistant/question-tray"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

// The tray reads the thread through assistant-ui's store; these tests stand
// in for it, since what they check is the tray, not the runtime.
const store = vi.hoisted(() => ({ after: [] as ("user" | "assistant")[] }))
vi.mock("@assistant-ui/react", async (original) => ({
  ...(await original<typeof import("@assistant-ui/react")>()),
  useAuiState: (select: (state: unknown) => unknown) =>
    select({
      message: { id: "msg-1", parts: [] },
      thread: {
        isRunning: false,
        messages: [
          { id: "msg-1", role: "assistant" },
          ...store.after.map((role, i) => ({ id: `after-${i}`, role })),
        ],
      },
    }),
  useAui: () => ({ thread: () => ({ append: vi.fn() }) }),
  useThreadViewportStore: () => null,
}))

// Stripe.js is Stripe's to load; the dialog's part is starting Checkout with
// the client secret the api returned, mounting the Elements, showing
// Stripe's total and confirming with what the owner already gave.
const stripe = vi.hoisted(() => {
  // Each Element's options by kind, and its event handlers by "kind:event"
  // for the test to fire.
  const options: Record<string, unknown> = {}
  const handlers: Record<string, (event: unknown) => void> = {}
  const element = (kind: string) => (given?: unknown) => {
    options[kind] = given
    return {
      mount: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn((event: string, handler: (event: unknown) => void) => {
        handlers[`${kind}:${event}`] = handler
      }),
    }
  }
  const confirm = vi.fn(
    async (
      _options: unknown
    ): Promise<
      { type: "success" } | { type: "error"; error: { message: string } }
    > => ({
      type: "success",
    })
  )
  const session = {
    currency: "gbp",
    minorUnitsAmountDivisor: 100,
    total: { total: { minorUnitsAmount: 800 } },
  }
  return {
    confirm,
    options,
    handlers,
    init: vi.fn(async (..._args: unknown[]) => ({
      on: vi.fn(),
      createExpressCheckoutElement: vi.fn(element("express")),
      createPaymentElement: vi.fn(element("payment")),
      loadActions: async () => ({
        type: "success" as const,
        actions: { confirm, getSession: () => session },
      }),
    })),
  }
})
vi.mock("@workspace/ui/lib/stripe", async (original) => ({
  ...(await original<typeof import("@workspace/ui/lib/stripe")>()),
  initCheckout: stripe.init,
}))

const NAME = "sparkleclean.co.uk"
const REGISTRANT = {
  name: "Jane Smith",
  business_name: "Sparkle Clean",
  email: "jane@sparkle.example",
  phone: "+447700900123",
  address: {
    street: "12 Mill Lane",
    city: "Bristol",
    postal_code: "BS1 4AB",
    country_code: "GB",
  },
}
const FREE = (price: number) => ({ state: "free", price_gbp_year: price })
const FOUND = {
  outcome: "found",
  rows: [
    {
      stem: "sparkleclean",
      why: "Short, and it is your name.",
      endings: { "co.uk": FREE(8), com: { state: "taken" }, uk: FREE(8) },
    },
    // The sandbox sells .com only, so a row may carry that ending alone.
    {
      stem: "sparklecleanbristol",
      why: "Says where you work.",
      endings: { com: FREE(12) },
    },
  ],
}
const PREFILL: DomainRegistrantPrefill = {
  name: NAME,
  price_gbp_year: 8,
  registrant: {
    name: REGISTRANT.name,
    business_name: REGISTRANT.business_name,
    email: REGISTRANT.email,
    phone: REGISTRANT.phone,
  },
  missing: ["street", "city", "postal_code", "country_code", "registrant_type"],
}
const OPEN: CheckoutStart = {
  outcome: "open",
  publishable_key: "pk_test_1",
  client_secret: "cs_x",
}

type Read = Omit<DomainPurchaseStatus, "name">

const purchaseOf = (overrides: Partial<DomainPurchase> = {}) => ({
  registrant: vi.fn(async () => PREFILL),
  checkout: vi.fn(async () => OPEN),
  status: vi.fn(async (): Promise<DomainPurchaseStatus | null> => null),
  elsewhere: vi.fn(async () => undefined),
  bought: vi.fn(
    async (name: string) => ({ outcome: "not_registered_yet", name }) as const
  ),
  ...overrides,
})

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = () => undefined
      unobserve = () => undefined
      disconnect = () => undefined
    }
  )
  HTMLElement.prototype.checkVisibility ??= () => true
})

afterEach(() => {
  store.after = []
  stripe.init.mockClear()
  stripe.confirm.mockClear()
  sessionStorage.clear()
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
})

/** Draws a CoS tool part as the thread does, with a tray slot and the buy calls. */
async function draw(
  toolName: string,
  props: Record<string, unknown>,
  purchase: DomainPurchase = purchaseOf()
) {
  const chat = document.createElement("div")
  const tray = document.createElement("div")
  document.body.appendChild(chat)
  document.body.appendChild(tray)
  const root = createRoot(chat)
  await act(async () =>
    root.render(
      createElement(
        TraySlotProvider,
        { value: tray },
        createElement(
          DomainPurchaseProvider,
          { value: purchase },
          createElement(Approval, {
            toolName,
            toolCallId: "call-1",
            argsText: "",
            respondToApproval: vi.fn(),
            ...props,
          } as never)
        )
      )
    )
  )
  return { chat, tray, purchase }
}

const found = () => draw("find_domain", { args: {}, result: FOUND })

const button = (within: Element, label: string) => {
  const match = [...within.querySelectorAll("button")].find(
    (each) =>
      each.textContent?.trim() === label ||
      each.getAttribute("aria-label") === label
  )
  if (!match) throw new Error(`no ${label} button`)
  return match
}
const press = (within: Element, label: string) =>
  act(async () => button(within, label).click())

const radio = (within: Element, label: string) => {
  const match = within.querySelector<HTMLInputElement>(
    `input[type=radio][aria-label="${label}"]`
  )
  if (!match) throw new Error(`no ${label} option`)
  return match
}

/** Picks an ending on Choose, then goes on, as the owner does. */
const choose = async (within: Element, label: string) => {
  await act(async () => radio(within, label).click())
  await press(within, "Continue")
}

/** Fills the fields the details page asks for, as the owner types them. */
const fill = (tray: HTMLElement, values: Record<string, string>) => {
  for (const [name, value] of Object.entries(values)) {
    const input = tray.querySelector<HTMLInputElement>(
      `input[name="${name}"]:not([type=hidden])`
    )
    if (!input) throw new Error(`no ${name} field`)
    if (input.type === "radio") {
      tray
        .querySelector<HTMLInputElement>(
          `input[name="${name}"][value="${value}"]`
        )
        ?.click()
    } else input.value = value
  }
}

const submit = (tray: HTMLElement) =>
  act(async () =>
    tray
      .querySelector<HTMLFormElement>("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  )

it("offers one row a name, best first, with each ending's price or taken", async () => {
  const { tray } = await found()
  const rows = tray.querySelectorAll('[role="radiogroup"] > div')
  expect([...rows].map((row) => row.textContent)).toEqual([
    "Best picksparkleclean" +
      "Short, and it is your name." +
      ".co.uk£8/yr.comtaken.uk£8/yr",
    "sparklecleanbristolSays where you work..com£12/yr",
  ])
  // A taken ending is no option; the free ones are one radio group, the best ticked.
  expect(() => radio(tray, "sparkleclean.com, £12 a year")).toThrow()
  const options = [
    ...tray.querySelectorAll<HTMLInputElement>("input[type=radio]"),
  ]
  expect(new Set(options.map((option) => option.name)).size).toBe(1)
  expect(
    options.filter((option) => option.checked).map((o) => o.value)
  ).toEqual([NAME])
})

it("goes on with the ending picked, not the best one", async () => {
  const purchase = purchaseOf()
  const { tray } = await draw(
    "find_domain",
    { args: {}, result: FOUND },
    purchase
  )
  await choose(tray, "sparklecleanbristol.com, £12 a year")
  expect(purchase.registrant).toHaveBeenCalledWith("sparklecleanbristol.com")
})

it("says plainly when no name was free", async () => {
  const { chat, tray } = await draw("find_domain", {
    args: {},
    result: {
      outcome: "refused",
      error: { class: "resource", code: "domain.unavailable", message: "x" },
    },
  })
  expect(chat.textContent).toContain("None of the names I tried are free.")
  expect(tray.textContent).toBe("")
})

it("reads a search stored before the name rows as one line, not a failure", async () => {
  const { chat, tray } = await draw("find_domain", {
    args: {},
    result: {
      outcome: "found",
      best: { name: "sparkleclean.com", price_gbp_year: 12, why: "Short." },
      options: [],
    },
  })
  expect(chat.textContent).toContain("I suggested some names here earlier.")
  expect(tray.textContent).toBe("")
})

it("asks only for the gaps, pays in a dialog, and leaves one line once paid", async () => {
  const purchase = purchaseOf()
  const { chat, tray } = await draw(
    "find_domain",
    { args: {}, result: FOUND },
    purchase
  )
  await choose(tray, `${NAME}, £8 a year`)
  expect(purchase.registrant).toHaveBeenCalledWith(NAME)
  // What Reme holds is not asked again; the address and the legal type are.
  const asked = [
    ...tray.querySelectorAll<HTMLInputElement>("input:not([type=hidden])"),
  ].map((input) => input.name)
  expect(new Set(asked)).toEqual(
    new Set([
      "street",
      "city",
      "postal_code",
      "country_code",
      "registrant_type",
    ])
  )
  expect(button(tray, "Pay £8")).toBeTruthy()

  fill(tray, {
    street: "12 Mill Lane",
    city: "Bristol",
    postal_code: "bs1 4ab",
    country_code: "gb",
    registrant_type: "STRA",
  })
  await submit(tray)
  expect(purchase.checkout).toHaveBeenCalledWith(NAME, {
    registrant: REGISTRANT,
    registrant_type: "STRA",
  })
  const dialog = document.querySelector('[data-slot="dialog-content"]')
  expect(dialog?.textContent).toContain("Payment details")
  expect(dialog?.textContent).toContain("Renews at £8 a year, cancel any time.")
  // Stripe gets the address the owner already gave, not a blank. The email
  // is the Customer's, set by the api: Elements refuse a second one.
  const contact = {
    name: REGISTRANT.name,
    address: {
      country: "GB",
      line1: "12 Mill Lane",
      city: "Bristol",
      postal_code: "BS1 4AB",
    },
  }
  expect(stripe.init.mock.calls[0]?.slice(1)).toEqual([
    "pk_test_1",
    "cs_x",
    { billingAddress: contact },
  ])
  // What confirm sends, the card form must not also ask for, or Stripe
  // refuses the confirm. Link is the button above, not a sign-up in the
  // card form, and the renewal consent is ours, under Pay.
  expect(stripe.options.payment).toEqual({
    fields: { billingDetails: { name: "never", address: "never" } },
    wallets: { link: "never" },
    terms: { card: "never" },
  })
  expect(dialog?.textContent).toContain(
    `By paying you let Reme charge this card £8 a year to renew ${NAME} until you cancel.`
  )

  // Wallets that fail to load go away, and the card form still pays.
  await vi.waitFor(() =>
    expect(stripe.handlers["express:loaderror"]).toBeTruthy()
  )
  await act(async () => stripe.handlers["express:loaderror"]?.({}))
  expect(
    dialog?.querySelector<HTMLElement>('[data-slot="domain-wallets"]')?.hidden
  ).toBe(true)
  expect(dialog?.textContent).not.toContain("did not load")

  // Stripe answers a decline in words, under Pay, and Pay comes back.
  stripe.confirm.mockResolvedValueOnce({
    type: "error",
    error: { message: "Your card was declined." },
  })
  const pay = () => button(dialog as Element, "Pay £8")
  await vi.waitFor(() => expect(pay().getAttribute("aria-busy")).toBeNull())
  await act(async () => pay().click())
  expect(dialog?.querySelector('[role="alert"]')?.textContent).toBe(
    "Your card was declined."
  )
  expect(pay().getAttribute("aria-busy")).toBeNull()

  // A confirm Stripe throws from is said the same way, not swallowed.
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
  stripe.confirm.mockRejectedValueOnce(new Error("IntegrationError"))
  await act(async () => pay().click())
  expect(dialog?.querySelector('[role="alert"]')?.textContent).toBe(
    "The payment could not be made. Try again."
  )
  expect(pay().getAttribute("aria-busy")).toBeNull()
  logged.mockRestore()

  await act(async () => pay().click())
  expect(stripe.confirm).toHaveBeenLastCalledWith({
    redirect: "if_required",
    billingAddress: contact,
  })
  await vi.waitFor(() =>
    expect(chat.textContent).toContain(
      `Payment approved. I'm registering ${NAME}`
    )
  )
  expect(tray.textContent).toBe("")
  expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull()
})

it("opens Your details from buy_domain's prefill without reading it again", async () => {
  const purchase = purchaseOf()
  const { tray } = await draw(
    "buy_domain",
    { args: { name: NAME }, result: { outcome: "details", ...PREFILL } },
    purchase
  )
  expect(purchase.registrant).not.toHaveBeenCalled()
  expect(tray.querySelector('input[name="street"]')).toBeTruthy()
  expect(
    tray.querySelector('input[name="email"]:not([type=hidden])')
  ).toBeNull()
  expect(button(tray, "Pay £8")).toBeTruthy()
})

it("keeps a fresh Pay after the dialog closes unpaid", async () => {
  const purchase = purchaseOf()
  const { tray } = await draw(
    "buy_domain",
    {
      args: { name: NAME, registrant: REGISTRANT, registrant_type: "STRA" },
      result: {
        outcome: "awaiting_payment",
        name: NAME,
        price_gbp: 8,
        checkout: "embedded",
      },
    },
    purchaseOf({
      ...purchase,
      registrant: vi.fn(async () => ({
        ...PREFILL,
        registrant: REGISTRANT,
        missing: [],
      })),
    })
  )
  // Nothing is missing, but a .co.uk still needs its legal type.
  fill(tray, { registrant_type: "LTD", company_number: "" })
  await submit(tray)
  expect(tray.textContent).toContain(
    "Write the 8-character Companies House number."
  )
  fill(tray, { company_number: "sc123456" })
  await submit(tray)
  await act(async () =>
    button(document.body, "Close").dispatchEvent(
      new MouseEvent("click", { bubbles: true })
    )
  )
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull()
  )
  await vi.waitFor(() => expect(button(tray, "Pay £8").disabled).toBe(false))
})

it("says a refusal by its code", async () => {
  const { tray } = await draw(
    "buy_domain",
    {
      args: { name: "sparkleclean.com", registrant: REGISTRANT },
      result: {
        outcome: "awaiting_payment",
        name: "sparkleclean.com",
        price_gbp: 12,
        checkout: "embedded",
      },
    },
    purchaseOf({
      registrant: vi.fn(async () => ({ refused: "domain.unavailable" })),
    })
  )
  expect(tray.querySelector('[role="alert"]')?.textContent).toContain(
    "That name isn't free to register"
  )
})

it("shows a name already bought as its line, with no Pay", async () => {
  const read: Read = { state: "active", test: false, outcome: "registered" }
  const { chat, tray } = await draw(
    "find_domain",
    { args: {}, result: FOUND },
    purchaseOf({ status: vi.fn(async () => ({ name: NAME, ...read })) })
  )
  await choose(tray, `${NAME}, £8 a year`)
  await vi.waitFor(() =>
    expect(chat.textContent).toContain(
      `${NAME} is yours, and your website is on it.`
    )
  )
  expect(tray.textContent).toBe("")
})

it("buys elsewhere: links with the name, tells the api, then waits for done", async () => {
  const purchase = purchaseOf()
  const { tray } = await draw(
    "find_domain",
    { args: {}, result: FOUND },
    purchase
  )
  await press(tray, "Buy it somewhere else")
  const links = [...tray.querySelectorAll("a")].map((a) => a.href)
  expect(links).toEqual([
    `https://domains.cloudflare.com/?domain=${NAME}`,
    `https://www.godaddy.com/domainsearch/find?domainToCheck=${NAME}`,
  ])
  await act(async () => tray.querySelector("a")?.click())
  expect(purchase.elsewhere).toHaveBeenCalledWith(NAME)
  expect(tray.querySelector("h2")?.textContent).toBe(
    "Tell me when you've bought it"
  )

  await press(tray, "Done, I bought it")
  expect(purchase.bought).toHaveBeenCalledWith(NAME)
  expect(tray.textContent).toContain(`I can't see ${NAME} at the registry yet.`)
})

it("connects a name bought elsewhere once the registry shows it", async () => {
  const { chat, tray } = await draw(
    "find_domain",
    { args: {}, result: FOUND },
    purchaseOf({
      bought: vi.fn(async () => ({
        outcome: "connecting" as const,
        method: "records" as const,
        email_affected: false,
        steps: [
          {
            type: "CNAME" as const,
            name: "www",
            value: "domains.remeai.co.uk",
          },
        ],
      })),
    })
  )
  await press(tray, "Buy it somewhere else")
  await act(async () => tray.querySelector("a")?.click())
  await press(tray, "Done, I bought it")
  expect(chat.textContent).toContain(`${NAME} is yours.`)
  expect(chat.querySelectorAll("ol > li")).toHaveLength(1)
  expect(tray.textContent).toBe("")
})

it("leaves one line on Not now, and none of the tray once the chat moves on", async () => {
  const { chat, tray } = await found()
  await press(tray, "Not now")
  expect(chat.textContent).toBe("You said not now.")
  expect(tray.textContent).toBe("")

  sessionStorage.clear()
  store.after = ["user"]
  const later = await found()
  expect(later.chat.textContent).toBe(
    "Names I found: sparkleclean, sparklecleanbristol."
  )
  expect(later.tray.textContent).toBe("")
})

it("stays open when the assistant posts below it, as the site going live does", async () => {
  store.after = ["assistant"]
  const { tray } = await found()
  expect(tray.textContent).toContain("sparkleclean")
})

it("reads every purchase outcome in the card's words", () => {
  const of = (read: Read) => purchaseStatusOf({ name: NAME, ...read })
  expect(purchaseStatusOf(null)).toBeNull()
  expect(of({ state: "awaiting_payment", test: false })).toBeNull()
  expect(of({ state: "verifying", test: true })).toBe("authorised")
  expect(of({ state: "active", test: true })).toBe("test")
  // A sandbox purchase ends removed, never active, and still reads as a test.
  expect(of({ state: "removed", test: true, outcome: "test_registered" })).toBe(
    "test"
  )
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
  business_name: "Sparkle Clean",
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
      registrant: REGISTRANT,
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
