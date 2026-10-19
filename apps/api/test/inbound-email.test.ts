import type { Header } from "postal-mime"
import { describe, expect, it } from "vitest"
import { authenticated, stripReply } from "../src/inbound-email.ts"

const header = (key: string, value: string): Header => ({
  key,
  originalKey: key,
  value,
})
const results = (value: string) => header("authentication-results", value)

describe("authenticated", () => {
  it("accepts a DMARC pass for the From domain", () => {
    expect(
      authenticated(
        [
          results(
            "mx.cloudflare.net; dkim=pass header.d=gmail.com; dmarc=pass header.from=gmail.com policy.dmarc=none"
          ),
        ],
        "gmail.com"
      )
    ).toBe(true)
  })

  it("accepts an aligned DKIM or SPF pass when the domain publishes no DMARC", () => {
    const dkim =
      "mx.cloudflare.net; dkim=pass header.d=example.co.uk; dmarc=none"
    const spf =
      "mx.cloudflare.net; spf=pass (mx.cloudflare.net: ok) smtp.mailfrom=owner@mail.example.co.uk; dmarc=none"
    expect(authenticated([results(dkim)], "mail.example.co.uk")).toBe(true)
    expect(authenticated([results(spf)], "mail.example.co.uk")).toBe(true)
  })

  it("reads the ARC copy Email Routing writes", () => {
    expect(
      authenticated(
        [
          header(
            "arc-authentication-results",
            "i=1; mx.cloudflare.net; dmarc=pass header.from=example.com; spf=pass smtp.mailfrom=example.com"
          ),
        ],
        "example.com"
      )
    ).toBe(true)
  })

  it("refuses a pass for another domain", () => {
    // Signed by the attacker's own domain, claiming the owner's address.
    expect(
      authenticated(
        [
          results(
            "mx.cloudflare.net; dkim=pass header.d=attacker.test; spf=pass smtp.mailfrom=bounce@attacker.test; dmarc=fail header.from=gmail.com"
          ),
        ],
        "gmail.com"
      )
    ).toBe(false)
    expect(
      authenticated(
        [results("mx.cloudflare.net; dkim=pass header.d=attacker.test")],
        "gmail.com"
      )
    ).toBe(false)
  })

  it("refuses an explicit DMARC failure even beside an aligned pass", () => {
    expect(
      authenticated(
        [
          results(
            "mx.cloudflare.net; spf=pass smtp.mailfrom=example.com; dmarc=fail header.from=example.com"
          ),
        ],
        "example.com"
      )
    ).toBe(false)
  })

  it("believes only the server Email Routing names, and its topmost header", () => {
    const planted = results(
      "mx.cloudflare.net; dmarc=pass header.from=example.com"
    )
    const other = results(
      "mail.attacker.test; dmarc=pass header.from=example.com"
    )
    const ours = results(
      "mx.cloudflare.net; dmarc=fail header.from=example.com"
    )
    expect(authenticated([other], "example.com")).toBe(false)
    // Ours is written on top at receipt; the sender's copy sits below it.
    expect(authenticated([ours, planted], "example.com")).toBe(false)
  })

  it("fails closed with no results, or none it can read", () => {
    expect(authenticated([], "example.com")).toBe(false)
    expect(authenticated([results("mx.cloudflare.net")], "example.com")).toBe(
      false
    )
    expect(authenticated([results("???;;;")], "example.com")).toBe(false)
  })
})

describe("stripReply", () => {
  it("keeps the words above a Gmail attribution", () => {
    expect(
      stripReply(
        "Thursday works.\n\nOn Mon, 19 Oct 2026 at 09:00, Reme <hello@remeai.co.uk> wrote:\n> Reminder: call the plumber\n> at ten"
      )
    ).toBe("Thursday works.")
  })

  it("handles an attribution wrapped over two lines and other languages", () => {
    expect(
      stripReply(
        "Ja, gerne.\r\n\r\nAm 19.10.2026 um 09:00 schrieb Reme\r\n<hello@remeai.co.uk>:\r\n> Erinnerung"
      )
    ).toBe("Ja, gerne.")
    expect(
      stripReply("Oui.\n\nLe 19 oct. 2026 à 09:00, Reme a écrit :\n> Rappel")
    ).toBe("Oui.")
  })

  it("cuts an Outlook original-message line and its header block", () => {
    expect(
      stripReply(
        "Fine by me.\n\n-----Original Message-----\nFrom: Reme\nSent: Monday\nSubject: Reminder"
      )
    ).toBe("Fine by me.")
    expect(
      stripReply(
        "Fine by me.\n\nFrom: Reme <hello@remeai.co.uk>\nSent: Monday, 19 October 2026 09:00\nTo: Owner\nSubject: Reminder"
      )
    ).toBe("Fine by me.")
  })

  it("drops quoted lines but keeps inline answers beneath them", () => {
    expect(stripReply("> Call at ten?\nYes.\n> Bring the keys?\nNo.")).toBe(
      "Yes.\nNo."
    )
  })

  it("cuts a signature after the delimiter and a trailing device line", () => {
    expect(stripReply("Do it.\n\n-- \nJo Smith\n07700 900000")).toBe("Do it.")
    expect(stripReply("Do it.\n\nSent from my iPhone")).toBe("Do it.")
    expect(stripReply("Sent from my iPhone is a good phone.\n\nDo it.")).toBe(
      "Sent from my iPhone is a good phone.\n\nDo it."
    )
  })

  it("leaves nothing when the reply was only a quotation", () => {
    expect(stripReply("On Mon, 19 Oct 2026, Reme wrote:\n> Reminder")).toBe("")
    expect(stripReply("> Reminder\n> again")).toBe("")
  })

  it("keeps ordinary text that merely mentions a marker word", () => {
    expect(stripReply("On Friday I wrote the cheque.\nThanks.")).toBe(
      "On Friday I wrote the cheque.\nThanks."
    )
  })
})
