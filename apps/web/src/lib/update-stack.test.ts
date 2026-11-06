import { AddressStageName, type Journey } from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import { journeyItem, stackOrder } from "./update-stack"

/** `offerOf` in packages/db, which the draft-ready line (`addressLine`) reads. */
const OFFERS: Partial<Record<AddressStageName, Journey["address"]["offer"]>> = {
  none: "connect",
  unknown: "connect",
  choosing: "connect",
  buying_elsewhere: "connect",
  bought: "connect_bought",
}

const journey = (
  stage: AddressStageName,
  {
    website = "draft_ready",
    google = "waiting_for_domain",
    name = "sparkleclean.co.uk",
  }: {
    website?: Journey["website"]
    google?: Journey["google"]
    name?: string
  } = {}
): Journey => ({
  website,
  address: { stage, name, offer: OFFERS[stage] ?? null },
  google,
})

const shown = (j: Journey, site = true) => {
  const item = journeyItem(j, site)
  return item && [item.title, item.label, item.lead ? "first" : "after"]
}

describe("the journey's item in the stack", () => {
  it.each([
    ["none", ["Choose your domain", "Connect now", "after"]],
    ["unknown", ["Choose your domain", "Connect now", "after"]],
    ["choosing", ["Choose your domain", "Connect now", "after"]],
    ["put_off", ["Get found on Google", "Connect Search Console", "after"]],
    [
      "buying_elsewhere",
      ["Finished buying sparkleclean.co.uk?", "Connect it", "first"],
    ],
    ["bought", ["sparkleclean.co.uk is ready to connect", "Connect", "first"]],
    ["paying", null],
    ["declined", ["Get found on Google", "Connect Search Console", "after"]],
    ["connecting", ["Get found on Google", "Connect Search Console", "after"]],
    ["live", ["Get found on Google", "Connect Search Console", "after"]],
  ] as const)("%s", (stage, item) => {
    expect(shown(journey(stage, { google: "offerable" }))).toEqual(item)
  })

  it("covers every address stage", () => {
    const known = [
      "none",
      "unknown",
      "choosing",
      "put_off",
      "buying_elsewhere",
      "bought",
      "paying",
      "declined",
      "connecting",
      "live",
    ]
    expect([...AddressStageName.options].sort()).toEqual(known.sort())
  })

  it("offers Google until it is connected or turned down", () => {
    for (const google of ["offerable", "put_off", "setting_up"] as const) {
      expect(shown(journey("live", { google }))?.[0]).toBe(
        "Get found on Google"
      )
    }
    for (const google of ["connected", "declined"] as const) {
      expect(shown(journey("live", { google }))).toBeNull()
    }
  })

  it("keeps Google on the stack after the domain is put off, skipped or ignored, and the domain once Google is settled", () => {
    for (const google of ["offerable", "put_off", "setting_up"] as const) {
      expect(shown(journey("put_off", { google }))?.[0]).toBe(
        "Get found on Google"
      )
    }
    for (const google of ["connected", "declined"] as const) {
      expect(shown(journey("put_off", { google }))?.[0]).toBe("Add your domain")
      expect(shown(journey("declined", { google }))).toBeNull()
    }
    // No site to put on Google yet.
    expect(
      shown(
        journey("put_off", { website: "building", google: "offerable" }),
        false
      )
    ).toBeNull()
  })

  it("puts the address on a site only, but brings a bought name first anyway", () => {
    const building = { website: "building" } as const
    expect(shown(journey("unknown", building), false)).toBeNull()
    expect(shown(journey("put_off", building), false)).toBeNull()
    // A draft held for an update is a site on screen.
    expect(shown(journey("unknown", building), true)?.[0]).toBe(
      "Choose your domain"
    )
    expect(
      shown(journey("unknown", { website: "published" }), false)?.[0]
    ).toBe("Choose your domain")
    expect(shown(journey("bought", building), false)?.[2]).toBe("first")
    expect(shown(journey("buying_elsewhere", building), false)?.[2]).toBe(
      "first"
    )
  })

  it("asks about a name being bought only once the owner is back", () => {
    expect(journeyItem(journey("buying_elsewhere"), true, false)).toBeNull()
    expect(journeyItem(journey("buying_elsewhere"), true, true)?.title).toBe(
      "Finished buying sparkleclean.co.uk?"
    )
    expect(journeyItem(journey("put_off"), true, false)?.title).toBe(
      "Add your domain"
    )
  })

  it("says nothing before the api sends the journey", () => {
    expect(journeyItem(undefined, true)).toBeNull()
  })

  it("loads its skill by the press: each Connect carries its intent and words", () => {
    for (const stage of [
      "unknown",
      "put_off",
      "buying_elsewhere",
      "bought",
    ] as const) {
      expect(journeyItem(journey(stage), true)).toMatchObject({
        ask: "Help me set up my domain",
        intent: "connect_address",
      })
    }
    expect(
      journeyItem(journey("live", { google: "offerable" }), true)
    ).toMatchObject({
      ask: "Help me connect Google Search Console",
      intent: "connect_google",
    })
  })

  // The draft-ready line says "tap Connect on the card" exactly when the
  // journey has an offer. With the draft on screen the stack then holds the
  // address's Connect; with no offer, the address shows only after a Skip,
  // which the line leaves unsaid.
  it.each(AddressStageName.options)(
    "agrees with the draft-ready line at %s",
    (stage) => {
      const item = journeyItem(journey(stage), true)
      const address = item?.id === "address" ? item.label : null
      expect(address?.startsWith("Connect") ?? false).toBe(
        !!OFFERS[stage] || stage === "put_off"
      )
    }
  )
})

describe("the stack's order", () => {
  const lead = { lead: true, value: "bought" }
  const after = { lead: false, value: "address" }
  it("puts a lead item before the site, the rest after what waits", () => {
    expect(stackOrder(lead, ["site"], ["question", "reminder"])).toEqual([
      "bought",
      "site",
      "question",
      "reminder",
    ])
    expect(stackOrder(after, ["site"], ["question"])).toEqual([
      "site",
      "question",
      "address",
    ])
    expect(stackOrder(null, ["site"])).toEqual(["site"])
    expect(stackOrder(after, [])).toEqual(["address"])
  })
})
