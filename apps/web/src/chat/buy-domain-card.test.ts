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
  registrarPrice,
  SKIP_DOMAIN,
  subLine,
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
type Later = { role: "user" | "assistant"; content?: unknown[] }
const store = vi.hoisted(() => ({
  after: [] as Later[],
  append: vi.fn(),
}))
vi.mock("@assistant-ui/react", async (original) => ({
  ...(await original<typeof import("@assistant-ui/react")>()),
  useAuiState: (select: (state: unknown) => unknown) =>
    select({
      message: { id: "msg-1", parts: [] },
      thread: {
        isRunning: false,
        messages: [
          { id: "msg-1", role: "assistant", content: [] },
          ...store.after.map((later, i) => ({
            id: `after-${i}`,
            content: [],
            ...later,
          })),
        ],
      },
    }),
  useAui: () => ({ thread: () => ({ append: store.append }) }),
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
  buy_here: true,
}
/** The same names with buying here off: no Reme price, the registrar's where known. */
const FOUND_OFF = {
  outcome: "found",
  rows: [
    {
      stem: "sparkleclean",
      why: "Short, and it is your name.",
      endings: {
        "co.uk": { state: "free", registrar_usd: 5.3 },
        com: { state: "taken" },
        uk: { state: "free" },
        co: { state: "free" },
      },
    },
    {
      stem: "sparklecleanbristol",
      why: "Says where you work.",
      endings: { com: { state: "free", registrar_usd: 10.46 } },
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
  store.append.mockClear()
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
      each.getAttribute("aria-label") === label ||
      // A name's row: its name, and "Choose" only a screen reader hears.
      each.querySelector("[title]")?.textContent === label
  )
  if (!match) throw new Error(`no ${label} button`)
  return match
}
const press = (within: Element, label: string) =>
  act(async () => button(within, label).click())

/** Chooses a name in the chat, then buys it here, as the owner does. */
const choose = async (chat: Element, name: string) => {
  await press(chat, `Choose ${name}`)
  const buy = [...chat.querySelectorAll("button")].find((each) =>
    each.textContent?.startsWith("Buy for ")
  )
  if (!buy) throw new Error(`no Buy for ${name}`)
  await act(async () => buy.click())
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

/** The picker's names, in order. */
const names = (chat: HTMLElement) =>
  [...chat.querySelectorAll('[data-slot="domain-picker"] li')].map((row) =>
    row.querySelector("[title]")?.getAttribute("title")
  )
/** Each name's row as the owner reads it: name | sub line | badge. */
const rows = (chat: HTMLElement) =>
  [...chat.querySelectorAll('[data-slot="domain-picker"] li')].map((row) =>
    [
      row.querySelector("[title]")?.getAttribute("title"),
      row.querySelector("[id$='-sub']")?.textContent,
      row.querySelector('[data-slot="badge"]')?.textContent,
    ]
      .filter(Boolean)
      .join(" | ")
  )
const picker = (chat: HTMLElement) =>
  chat.querySelector('[data-slot="domain-picker"]')

it("shows the names in the message, six at most: the recommended one first, then every .co.uk", async () => {
  const all = { "co.uk": FREE(8), com: FREE(12), uk: FREE(8) }
  const { chat, tray } = await draw("find_domain", {
    args: {},
    result: {
      outcome: "found",
      buy_here: true,
      rows: ["a", "b", "c", "d", "e", "f"].map((stem) => ({
        stem,
        why: "x",
        endings: stem === "b" ? { com: FREE(12) } : all,
      })),
    },
  })
  expect(names(chat)).toEqual([
    "a.co.uk",
    "c.co.uk",
    "d.co.uk",
    "e.co.uk",
    "f.co.uk",
    "a.uk",
  ])
  // The step line counts what the list shows, not the stems searched.
  expect(chat.textContent).toContain("Found 6 names")
  expect(picker(chat)?.querySelectorAll('[data-slot="badge"]')).toHaveLength(1)
  expect(tray.textContent).toBe("")
})

it("gives each row its name, price and Recommended badge, and Choose for the whole row", async () => {
  const { chat } = await found()
  expect(picker(chat)?.querySelector("h3")?.textContent).toBe(
    "Choose your domain"
  )
  expect(picker(chat)?.textContent).toContain(
    "You can do this before your site is published. I'll connect it for you."
  )
  expect(rows(chat)).toEqual([
    "sparkleclean.co.uk | £8 a year | Recommended",
    "sparkleclean.uk | £8 a year",
    "sparklecleanbristol.com | £12 a year",
  ])
  expect(() => button(chat, "Choose sparkleclean.com")).toThrow()
  // The reason describes the recommended name, and no other.
  const why = button(chat, `Choose ${NAME}`)
    .getAttribute("aria-describedby")
    ?.split(" ")
    .at(-1)
  expect(document.getElementById(why ?? "")?.textContent).toBe(
    "Recommended. Short, and it is your name."
  )
  expect(
    button(chat, "Choose sparkleclean.uk").getAttribute("aria-describedby")
  ).not.toContain("why")
})

it("prices every row in pounds at Cloudflare, or says where to see it", async () => {
  const { chat } = await draw("find_domain", {
    args: {},
    result: { ...FOUND_OFF, usd_gbp: 0.7457 },
  })
  expect(rows(chat)).toEqual([
    "sparkleclean.co.uk | About £4 a year at Cloudflare | Recommended",
    "sparkleclean.uk | Price shown at Cloudflare",
    "sparkleclean.co | Price shown at Cloudflare",
    "sparklecleanbristol.com | About £8 a year at Cloudflare",
  ])
  expect(chat.textContent).not.toContain("$")
})

it("registrarPrice is pounds to the nearest pound, at least £1, and nothing without a rate", () => {
  expect(registrarPrice(5.3, 0.7457)).toBe("About £4 a year")
  expect(registrarPrice(10.46, 0.7457)).toBe("About £8 a year")
  expect(registrarPrice(6, 0.75)).toBe("About £5 a year")
  expect(registrarPrice(0.5, 0.7457)).toBe("About £1 a year")
  expect(registrarPrice(5.3)).toBeNull()
  expect(subLine({ usd: 5.3 }, false)).toBe("Price shown at Cloudflare")
  expect(subLine({ price: 8, usd: 5.3 }, true)).toBe("£8 a year")
  expect(subLine({}, true)).toBeNull()
})

it("with buying here off, gives a chosen name Buy from each provider, and I've bought it says so in the chat", async () => {
  const purchase = purchaseOf()
  const { chat } = await draw(
    "find_domain",
    { args: {}, result: FOUND_OFF },
    purchase
  )
  expect(chat.querySelector("a")).toBeNull()
  expect(() => button(chat, "I've bought it")).toThrow()
  await press(chat, "Choose sparkleclean.co")
  expect(
    chat.querySelector('[data-slot="domain-chosen"]')?.textContent
  ).toContain("sparkleclean.co")
  expect(() => button(chat, "Choose sparkleclean.co")).toThrow()
  expect(() => button(chat, "Buy for £8")).toThrow()
  const links = [...chat.querySelectorAll("a")]
  expect(links.map((a) => a.textContent)).toEqual([
    "Buy from Cloudflare (opens in a new tab)",
    "Buy from GoDaddy (opens in a new tab)",
  ])
  expect(links.map((a) => a.href)).toEqual([
    "https://domains.cloudflare.com/?domain=sparkleclean.co",
    "https://www.godaddy.com/domainsearch/find?domainToCheck=sparkleclean.co",
  ])
  await act(async () => links[0]?.click())
  expect(purchase.elsewhere).toHaveBeenCalledWith("sparkleclean.co")
  await press(chat, "I've bought it")
  expect(store.append).toHaveBeenCalledWith("I've bought sparkleclean.co")
  expect(button(chat, "Skip for now").disabled).toBe(true)
})

it("goes on with the ending picked, not the best one", async () => {
  const purchase = purchaseOf()
  const { chat } = await draw(
    "find_domain",
    { args: {}, result: FOUND },
    purchase
  )
  await choose(chat, "sparklecleanbristol.com")
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
  await choose(chat, NAME)
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

  // A field whose row partner is already held takes the whole row.
  const span = (name: string) =>
    tray
      .querySelector(`[name=${name}]`)
      ?.closest('[data-slot="field"]')
      ?.className.split(" ")
  expect(span("street")).toContain("sm:col-span-6")
  expect(span("country_code")).toContain("sm:col-span-6")
  expect(span("country_code")).not.toContain("sm:col-span-2")
  expect(span("city")).toContain("sm:col-span-3")
  expect(span("postal_code")).toContain("sm:col-span-3")

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

it("opens Pay at the first press when the name was given up before", async () => {
  // An earlier unpaid purchase of the name reads abandoned until Pay starts a new one.
  const status = vi
    .fn<() => Promise<DomainPurchaseStatus | null>>()
    .mockResolvedValueOnce({ name: NAME, state: "abandoned", test: false })
    .mockResolvedValue(null)
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
      status,
      registrant: vi.fn(async () => ({
        ...PREFILL,
        registrant: REGISTRANT,
        missing: [],
      })),
    })
  )
  await vi.waitFor(() => expect(button(tray, "Pay £8").disabled).toBe(false))
  // The earlier purchase's lapse is not news on a page that has not paid yet.
  expect(tray.textContent).not.toContain("timed out")
  fill(tray, { registrant_type: "LTD", company_number: "sc123456" })
  await submit(tray)
  await vi.waitFor(() =>
    expect(status.mock.calls.length).toBeGreaterThanOrEqual(2)
  )
  expect(document.querySelector('[data-slot="dialog-content"]')).not.toBeNull()
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
  await choose(chat, NAME)
  await vi.waitFor(() =>
    expect(chat.textContent).toContain(
      `${NAME} is yours, and your website is on it.`
    )
  )
  expect(tray.textContent).toBe("")
})

it("with buying here on, a chosen name offers Buy for its price and each provider", async () => {
  const purchase = purchaseOf()
  const { chat, tray } = await draw(
    "find_domain",
    { args: {}, result: FOUND },
    purchase
  )
  await press(chat, `Choose ${NAME}`)
  expect(
    [
      ...chat.querySelectorAll(
        '[data-slot="domain-chosen"] a, [data-slot="domain-chosen"] button'
      ),
    ].map((each) => each.textContent)
  ).toEqual([
    "Buy for £8",
    "Buy from Cloudflare (opens in a new tab)",
    "Buy from GoDaddy (opens in a new tab)",
  ])
  expect(tray.textContent).toBe("")
  expect(purchase.registrant).not.toHaveBeenCalled()
})

it("says Skip for now in the chat, folds once it is sent, and gives way to a fresh list", async () => {
  const first = await found()
  await press(first.chat, "Skip for now")
  expect(store.append).toHaveBeenCalledWith(SKIP_DOMAIN)

  sessionStorage.clear()
  store.after = [
    { role: "user", content: [{ type: "text", text: SKIP_DOMAIN }] },
  ]
  const skipped = await found()
  expect(skipped.chat.textContent).toBe(
    "Found 3 namesNames I offered: sparkleclean.co.uk, sparkleclean.uk, sparklecleanbristol.com."
  )

  store.after.push({
    role: "assistant",
    content: [{ type: "tool-call", toolName: "find_domain" }],
  })
  const replaced = await found()
  expect(replaced.chat.textContent).toBe(
    "Found 3 namesYou skipped choosing, so there's a fresh list below."
  )
})

it("stays in the message while the owner chats about something else", async () => {
  store.after = [{ role: "user" }, { role: "assistant" }]
  const { chat } = await found()
  expect(picker(chat)).not.toBeNull()
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
