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

const shown = (j: Journey, site = true) =>
  journeyItem(j, site).map((item) => [
    item.title,
    item.label,
    item.lead ? "first" : "after",
  ])
const titles = (j: Journey, site = true) =>
  journeyItem(j, site).map((item) => item.title)

const DOMAIN = ["Add your domain", "Connect now", "after"]
const GOOGLE = ["Get found on Google", "Connect Search Console", "after"]

describe("the journey's items in the stack", () => {
  it.each([
    ["none", [["Choose your domain", "Connect now", "after"]]],
    ["unknown", [["Choose your domain", "Connect now", "after"]]],
    ["choosing", [["Choose your domain", "Connect now", "after"]]],
    ["put_off", [DOMAIN, GOOGLE]],
    [
      "buying_elsewhere",
      [["Finished buying sparkleclean.co.uk?", "Connect it", "first"]],
    ],
    [
      "bought",
      [["sparkleclean.co.uk is ready to connect", "Connect", "first"]],
    ],
    ["paying", []],
    ["declined", [GOOGLE]],
    ["connecting", [GOOGLE]],
    ["live", [GOOGLE]],
  ] as const)("%s", (stage, items) => {
    expect(shown(journey(stage, { google: "offerable" }))).toEqual(items)
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
      expect(titles(journey("live", { google }))).toEqual([
        "Get found on Google",
      ])
    }
    for (const google of ["connected", "declined"] as const) {
      expect(shown(journey("live", { google }))).toEqual([])
    }
  })

  it("keeps a skipped domain on the stack with Google after it, and a declined one shows Google alone", () => {
    for (const google of ["offerable", "put_off", "setting_up"] as const) {
      expect(shown(journey("put_off", { google }))).toEqual([DOMAIN, GOOGLE])
      expect(shown(journey("declined", { google }))).toEqual([GOOGLE])
    }
    for (const google of ["connected", "declined"] as const) {
      expect(shown(journey("put_off", { google }))).toEqual([DOMAIN])
      expect(shown(journey("declined", { google }))).toEqual([])
    }
    // No site to put on Google yet.
    expect(
      shown(
        journey("put_off", { website: "building", google: "offerable" }),
        false
      )
    ).toEqual([])
  })

  it("puts the address on a site only, but brings a bought name first anyway", () => {
    const building = { website: "building" } as const
    expect(shown(journey("unknown", building), false)).toEqual([])
    expect(shown(journey("put_off", building), false)).toEqual([])
    // A draft held for an update is a site on screen.
    expect(titles(journey("unknown", building), true)).toEqual([
      "Choose your domain",
    ])
    expect(titles(journey("unknown", { website: "published" }), false)).toEqual(
      ["Choose your domain"]
    )
    expect(shown(journey("bought", building), false)[0]?.[2]).toBe("first")
    expect(shown(journey("buying_elsewhere", building), false)[0]?.[2]).toBe(
      "first"
    )
  })

  it("asks about a name being bought only once the owner is back", () => {
    expect(journeyItem(journey("buying_elsewhere"), true, false)).toEqual([])
    expect(titles(journey("buying_elsewhere"))).toEqual([
      "Finished buying sparkleclean.co.uk?",
    ])
    expect(journeyItem(journey("put_off"), true, false)[0]?.title).toBe(
      "Add your domain"
    )
  })

  it("says nothing before the api sends the journey", () => {
    expect(journeyItem(undefined, true)).toEqual([])
  })

  it("loads its skill by the press: each Connect carries its intent and words", () => {
    for (const stage of [
      "unknown",
      "put_off",
      "buying_elsewhere",
      "bought",
    ] as const) {
      expect(journeyItem(journey(stage), true)).toMatchObject([
        { ask: "Help me set up my domain", intent: "connect_address" },
      ])
    }
    expect(
      journeyItem(journey("live", { google: "offerable" }), true)
    ).toMatchObject([
      {
        ask: "Help me connect Google Search Console",
        intent: "connect_google",
      },
    ])
  })

  // The draft-ready line says "tap Connect on the card" exactly when the
  // journey has an offer. With the draft on screen the stack then holds the
  // address's Connect; with no offer, the address shows only after a Skip,
  // which the line leaves unsaid.
  it.each(AddressStageName.options)(
    "agrees with the draft-ready line at %s",
    (stage) => {
      const address = journeyItem(journey(stage), true).find(
        (item) => item.id === "address"
      )?.label
      expect(address?.startsWith("Connect") ?? false).toBe(
        !!OFFERS[stage] || stage === "put_off"
      )
    }
  )
})

describe("the stack's order", () => {
  const lead = { lead: true, value: "bought" }
  const after = { lead: false, value: "address" }
  const google = { lead: false, value: "google" }
  it("puts a lead item before the site, the rest after what waits", () => {
    expect(stackOrder([lead], ["site"], ["question", "reminder"])).toEqual([
      "bought",
      "site",
      "question",
      "reminder",
    ])
    expect(stackOrder([after, google], ["site"], ["question"])).toEqual([
      "site",
      "question",
      "address",
      "google",
    ])
    expect(stackOrder([], ["site"])).toEqual(["site"])
    expect(stackOrder([after], [])).toEqual(["address"])
  })
})
