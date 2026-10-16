import { describe, expect, it } from "vitest"
import {
  CheckDomainOutput,
  ConnectDomainOutput,
  DnsRecord,
  DomainCheck,
  DomainName,
  DomainProvider,
  RemoveDomainOutput,
  ServerButtonPart,
  ServerMessage,
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
