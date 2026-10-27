import { describe, expect, it } from "vitest"
import {
  ADDRESS_ASK,
  addressReply,
  BUY_REFUSALS,
  BuyDomainAsk,
  BuyDomainInput,
  CheckDomainOutput,
  ConnectDomainOutput,
  DnsRecord,
  DOMAIN_PRICES,
  DomainCheck,
  DomainName,
  DomainPaymentEvent,
  DomainProvider,
  DomainRegistration,
  DomainTld,
  ErrorEnvelope,
  ownDomain,
  RemoveDomainOutput,
  ServerButtonPart,
  ServerMessage,
  sellableTld,
} from "../src/index.ts"
import { RedirectPointer, SitePointer } from "../src/site.ts"
import { ACCEPTED, REFUSED, verdict } from "./json-schema.ts"
import { samples } from "./samples.ts"

describe("DomainName", () => {
  it.each(["brightclean.co.uk", "xn--caf-dma.example", "a-b.example"])(
    "accepts %s",
    (name) => {
      expect(DomainName.safeParse(name).success).toBe(true)
    }
  )

  it.each([
    ["upper case", "BrightClean.co.uk"],
    ["unicode, not punycode", "café.example"],
    ["no dot", "localhost"],
    ["a leading hyphen", "-a.example"],
    ["a scheme", "https://brightclean.co.uk"],
    ["a path", "brightclean.co.uk/x"],
    ["a port", "brightclean.co.uk:8080"],
    ["over 253 characters", `${"a".repeat(60)}.`.repeat(5) + "example"],
  ])("refuses %s", (_name, name) => {
    expect(DomainName.safeParse(name).success).toBe(false)
  })
})

describe("DomainCheck", () => {
  it.each([
    "not_found",
    "unknown_error",
    "pending_verification",
    "invalid_configuration",
    "pending_certificate",
    "valid",
  ])("accepts a bare %s", (status) => {
    expect(verdict("DomainCheck", DomainCheck, { status })).toEqual(ACCEPTED)
  })

  const record = samples.DnsRecord as object

  it("accepts a conflict with its records", () => {
    const check = { status: "conflicting_record", conflicts: [record] }
    expect(verdict("DomainCheck", DomainCheck, check)).toEqual(ACCEPTED)
  })

  it.each([
    [
      "a conflict with no records",
      { status: "conflicting_record", conflicts: [] },
    ],
    ["a conflict with no list", { status: "conflicting_record" }],
    ["a status of its own", { status: "propagating" }],
    ["a bare valid carrying records", { status: "valid", conflicts: [record] }],
    [
      "eleven conflicts",
      { status: "conflicting_record", conflicts: Array(11).fill(record) },
    ],
  ])("refuses %s", (_name, check) => {
    expect(verdict("DomainCheck", DomainCheck, check)).toEqual(REFUSED)
  })
})

describe("DnsRecord", () => {
  it("refuses a type outside the ones an owner adds", () => {
    const record = { ...(samples.DnsRecord as object), type: "MX" }
    expect(verdict("DnsRecord", DnsRecord, record)).toEqual(REFUSED)
  })
})

describe("DomainProvider", () => {
  it("takes a name alone", () => {
    expect(
      verdict("DomainProvider", DomainProvider, { name: "Cloudflare" })
    ).toEqual(ACCEPTED)
  })

  it.each([
    "http://dcc.godaddy.com/manage/dns",
    "javascript:alert(1)",
    "dcc.godaddy.com",
  ])("refuses the settings link %s", (settings_url) => {
    expect(
      verdict("DomainProvider", DomainProvider, {
        name: "GoDaddy",
        settings_url,
      })
    ).toEqual(REFUSED)
  })
})

describe("the domain tools' outputs", () => {
  it("show a refusal as a refusal", () => {
    const refused = {
      outcome: "refused",
      error: {
        class: "validation",
        code: "domain.taken",
        message: "That domain is connected to another business.",
      },
    }
    expect(verdict("CheckDomainOutput", CheckDomainOutput, refused)).toEqual(
      ACCEPTED
    )
    expect(
      verdict("ConnectDomainOutput", ConnectDomainOutput, refused)
    ).toEqual(ACCEPTED)
    expect(verdict("RemoveDomainOutput", RemoveDomainOutput, refused)).toEqual(
      ACCEPTED
    )
  })

  it("carry no tenant or Cloudflare id field, even when offered one", () => {
    for (const [name, schema, extra] of [
      ["ConnectDomainOutput", ConnectDomainOutput, "org_id"],
      ["ConnectDomainOutput", ConnectDomainOutput, "cf_ids"],
      ["CheckDomainOutput", CheckDomainOutput, "custom_hostname_id"],
      ["RemoveDomainOutput", RemoveDomainOutput, "org_id"],
    ] as const) {
      const output = { ...(samples[name] as object), [extra]: "x" }
      expect(verdict(name, schema, output)).toEqual(REFUSED)
    }
  })
})

describe("the site's pointers", () => {
  const { canonical_host: _host, ...before } = samples.SitePointer as Record<
    string,
    unknown
  >

  it("still reads a pointer written before custom domains", () => {
    expect(SitePointer.parse(before)).toEqual(before)
  })

  it("carries the canonical host when there is one", () => {
    expect(SitePointer.parse(samples.SitePointer)).toEqual(samples.SitePointer)
    expect(
      SitePointer.safeParse({
        ...before,
        canonical_host: "Brightclean.example",
      }).success
    ).toBe(false)
  })

  it("keeps a redirect apart from a site", () => {
    expect(RedirectPointer.parse(samples.RedirectPointer)).toEqual(
      samples.RedirectPointer
    )
    expect(SitePointer.safeParse(samples.RedirectPointer).success).toBe(false)
    expect(RedirectPointer.safeParse(samples.SitePointer).success).toBe(false)
    expect(
      RedirectPointer.safeParse({ redirect_to: "https://a.example" }).success
    ).toBe(false)
  })
})

describe("ServerMessage", () => {
  const message = samples.ServerMessage as { id: string; text: string[] }

  it("takes text alone, or text and a button", () => {
    const { text, id } = message
    expect(verdict("ServerMessage", ServerMessage, { id, text })).toEqual(
      ACCEPTED
    )
    expect(
      verdict("ServerMessage", ServerMessage, samples.ServerMessage)
    ).toEqual(ACCEPTED)
  })

  it("takes a button that sends words the chat already understands", () => {
    const button = {
      label: "Done, I'll wait",
      action: { kind: "ask", text: "Done, I'll wait" },
    }
    expect(
      verdict("ServerMessage", ServerMessage, { ...message, button })
    ).toEqual(ACCEPTED)
  })

  it.each([
    ["no text", { ...message, text: [] }],
    ["blank text", { ...message, text: ["  "] }],
    ["an id with a space", { ...message, id: "domain live" }],
    [
      "a button that opens a script",
      {
        ...message,
        button: {
          label: "Go",
          action: { kind: "open", url: "javascript:alert(1)" },
        },
      },
    ],
    [
      "a button that opens plain http",
      {
        ...message,
        button: {
          label: "Go",
          action: { kind: "open", url: "http://brightclean.example" },
        },
      },
    ],
    [
      "a button with an action of its own",
      {
        ...message,
        button: { label: "Go", action: { kind: "run", text: "x" } },
      },
    ],
  ])("refuses %s", (_name, value) => {
    expect(verdict("ServerMessage", ServerMessage, value)).toEqual(REFUSED)
  })

  it("is stored as a data part named button", () => {
    expect(ServerButtonPart.parse(samples.ServerButtonPart)).toEqual(
      samples.ServerButtonPart
    )
    expect(
      ServerButtonPart.safeParse({
        ...(samples.ServerButtonPart as object),
        type: "tool-button",
      }).success
    ).toBe(false)
  })
})

describe("sellableTld", () => {
  it.each([
    ["brightclean.co.uk", "co.uk"],
    ["brightclean.uk", "uk"],
    ["brightclean.com", "com"],
    ["brightclean.net", "net"],
  ])("sells %s as %s", (name, tld) => {
    expect(sellableTld(name)).toBe(tld)
  })

  it.each([
    "book.brightclean.co.uk",
    "co.uk",
    "org.uk",
    "brightclean.org",
    "brightclean.org.uk",
  ])("does not sell %s", (name) => {
    expect(sellableTld(name)).toBeNull()
  })

  it("has a price for every ending it sells", () => {
    expect(Object.keys(DOMAIN_PRICES).sort()).toStrictEqual(
      [...DomainTld.options].sort()
    )
  })
})

describe("BuyDomainInput", () => {
  const input = samples.BuyDomainInput as {
    registrant: { address: object }
  }
  const registrant = (patch: object) => ({
    ...input,
    registrant: { ...input.registrant, ...patch },
  })
  it.each([
    [
      "a company number in lower case",
      { ...input, company_number: "sc123456" },
    ],
    [
      "a country by name",
      registrant({
        address: { ...input.registrant.address, country_code: "UK " },
      }),
    ],
    ["a phone not in E.164", registrant({ phone: "07700 900123" })],
    ["a registrant type of its own", { ...input, registrant_type: "CHARITY" }],
    ["a price from the model", { ...input, price_gbp: 1 }],
  ])("refuses %s", (_name, value) => {
    expect(verdict("BuyDomainInput", BuyDomainInput, value)).toEqual(REFUSED)
  })

  it("takes a county from a stored input, never from the model", () => {
    const county = registrant({
      address: { ...input.registrant.address, state: "Somerset" },
    })
    expect(BuyDomainInput.safeParse(county).success).toBe(true)
    expect(BuyDomainAsk.safeParse(county).success).toBe(false)
    expect(BuyDomainAsk.safeParse(input).success).toBe(true)
  })
})

describe("DomainPaymentEvent", () => {
  const paid = samples.DomainPaymentEvent as object
  it.each([
    [
      "a paid event with no payment intent",
      { ...paid, payment_intent: undefined },
    ],
    ["a secret riding along", { ...paid, client_secret: "cs_x_sec_y" }],
    ["an id of the wrong kind", { ...paid, payment_intent: "cs_test_a1" }],
  ])("refuses %s", (_name, value) => {
    expect(verdict("DomainPaymentEvent", DomainPaymentEvent, value)).toEqual(
      REFUSED
    )
  })

  it("accepts a renewal that failed", () => {
    const event = {
      type: "renewal_failed",
      event_id: "evt_9z8y7x",
      domain_id: "8a9b0c1d-2e3f-4a5b-9c6d-7e8f9a0b1c2d",
      subscription: "sub_1a2b3c",
      invoice: "in_1a2b3c",
    }
    expect(verdict("DomainPaymentEvent", DomainPaymentEvent, event)).toEqual(
      ACCEPTED
    )
  })
})

describe("DomainRegistration", () => {
  it("accepts the row's first shape, the sandbox flag alone", () => {
    expect(
      verdict("DomainRegistration", DomainRegistration, { sandbox: true })
    ).toEqual(ACCEPTED)
  })

  it.each([
    ["no sandbox flag", { status: "registered" }],
    ["an outcome of its own", { sandbox: true, outcome: "refunded" }],
  ])("refuses %s", (_name, value) => {
    expect(verdict("DomainRegistration", DomainRegistration, value)).toEqual(
      REFUSED
    )
  })
})

describe("BUY_REFUSALS", () => {
  it.each(Object.values(BUY_REFUSALS))("$code is an envelope code", (r) => {
    expect(ErrorEnvelope.shape.code.safeParse(r.code).success).toBe(true)
  })
})

describe("ownDomain", () => {
  it.each([
    ["Hello@NorthsideGrooming.co.uk", "northsidegrooming.co.uk"],
    ["jo@mail.brightclean.com", "mail.brightclean.com"],
  ])("takes the own domain of %s", (email, domain) => {
    expect(ownDomain(email)).toBe(domain)
  })

  it.each(["jo@gmail.com", "jo@Hotmail.co.uk", "jo@btinternet.com", "nobody"])(
    "takes none from %s",
    (email) => {
      expect(ownDomain(email)).toBeNull()
    }
  )
})

describe("addressReply", () => {
  it("speaks for Yes with and without a name, and for No", () => {
    expect(addressReply(ADDRESS_ASK.yes, "sparkle.co.uk")).toBe(
      "Yes, it's sparkle.co.uk"
    )
    expect(addressReply(ADDRESS_ASK.yes)).toBe("Yes, I have a web address")
    expect(addressReply(ADDRESS_ASK.no)).toBe(ADDRESS_ASK.no)
  })

  it("says nothing for Not now", () => {
    expect(addressReply(ADDRESS_ASK.later)).toBeNull()
  })
})
