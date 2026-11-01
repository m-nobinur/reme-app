import { describe, expect, it } from "vitest"
import {
  addressOffer,
  addressOfferOwn,
  domainTakesOver,
  googleOffer,
  liveAddressAgain,
  liveGoogleOffer,
  liveOffer,
  liveOnDomain,
  liveOwnAddress,
  livePadlock,
  liveSettingDue,
  liveSettingLapsed,
  onGoogle,
  padlockLine,
} from "../src/address-copy.ts"
import { JARGON, overLimit, type Update } from "../src/heartbeat-write.ts"

const DOX = { business: "DOX Cleaning", trade: "Cleaning", area: "London" }
const BARE = {}

/** Every moment, for a business with full facts and one with none. */
const moments = (about: typeof DOX | typeof BARE): [string, Update][] => [
  ["A, the address offer", addressOffer(about)],
  ["A, their email's domain", addressOfferOwn("doxcleaning.co.uk", about)],
  ["E, Google once the setting is in", googleOffer("dox.bnwise.tech", about)],
  ["G, live", liveOffer(about)],
  ["G, live with the padlock coming", livePadlock("dox.bnwise.tech", about)],
  ["G, live with the setting due", liveSettingDue("dox.bnwise.tech", about)],
  [
    "G, live after the claim lapsed",
    liveSettingLapsed("dox.bnwise.tech", about),
  ],
  [
    "G, live with their email's domain",
    liveOwnAddress("doxcleaning.co.uk", about),
  ],
  ["G, live with the address asked again", liveAddressAgain(about)],
  ["H2, Google on the free address", liveGoogleOffer(about)],
  [
    "G, the launch on their domain",
    liveOnDomain("dox.bnwise.tech", about, true),
  ],
  [
    "H, their domain takes over",
    domainTakesOver("dox.bnwise.tech", about, true),
  ],
  [
    "H, their domain replaces another",
    domainTakesOver("dox.bnwise.tech", about, false, "old.example.com"),
  ],
  ["I, on Google", onGoogle("dox.bnwise.tech", about)],
]

const jargon = new RegExp(`\\b(${JARGON.join("|")})s?\\b`, "i")

describe.each([
  ["a business with its facts", DOX],
  ["a business with none yet", BARE],
])(
  "what the owner hears about their address and Google, for %s",
  (_, about) => {
    it.each(moments(about))(
      "%s reads as a helpful assistant would say it",
      (_moment, update) => {
        const { template, brief = "", facts } = update
        // The owner's terms, never the plumbing.
        expect(template).not.toMatch(jargon)
        // Real wins only, never a stock opener.
        expect((template.match(/!/g) ?? []).length).toBeLessThanOrEqual(1)
        expect(template).not.toMatch(/^(Good news|Great|Nice work|Perfect)\b/i)
        // The model's version must fit the same limits, so the template shows them.
        expect(overLimit(template)).toBeNull()
        // Every fact the model must keep is in the template it stands in for.
        for (const value of Object.values(facts))
          expect(template).toContain(value)
        // Every brief names what the moment is for.
        expect(brief.length).toBeGreaterThan(80)
      }
    )

    it("names a benefit in the owner's terms in every offer", () => {
      const offers = [
        addressOffer(about),
        addressOfferOwn("doxcleaning.co.uk", about),
        googleOffer("dox.bnwise.tech", about),
        liveGoogleOffer(about),
        liveAddressAgain(about),
      ]
      for (const { template } of offers)
        expect(template).toMatch(/customers|people|Google|van|quotes/)
    })
  }
)

it("tells the brief about the business so the model can use its name, trade and area", () => {
  expect(addressOffer(DOX).brief).toContain(
    "About the business: DOX Cleaning, a cleaning business, serving London."
  )
  expect(addressOffer(BARE).brief).not.toContain("About the business")
})

it("says the padlock line in plain words, with no promise to report back", () => {
  expect(padlockLine("www.dox.co.uk")).toBe(
    "Your setting for www.dox.co.uk is in, so it just needs its security padlock now, which usually takes a few minutes."
  )
})
