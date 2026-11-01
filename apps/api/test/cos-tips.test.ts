import { describe, expect, it } from "vitest"
import { tipsDue } from "../src/cos/tips.ts"

const fact = (key: string, value: unknown) => ({ key, value })
const email = (address: string) => fact("business.email", { address })
const phone = (e164: string) => fact("business.phone", { e164 })
const area = (centre: string) =>
  fact("service_area.radius", { centre, radius_km: 20 })

const due = (
  facts: ReturnType<typeof fact>[],
  extra: Partial<Parameters<typeof tipsDue>[0]> = {}
) => tipsDue({ facts, live: true, domains: ["active"], given: [], ...extra })

describe("tips: a personal email on the website", () => {
  it("fires once the site is live and the owner has a domain of their own", () => {
    expect(due([email("jo@gmail.com")])).toEqual(["business_email"])
    expect(due([email("jo@outlook.com")], { domains: ["verifying"] })).toEqual([
      "business_email",
    ])
  })

  it("waits for a domain, and for the site to be live", () => {
    expect(due([email("jo@gmail.com")], { domains: [] })).toEqual([])
    expect(due([email("jo@gmail.com")], { domains: ["abandoned"] })).toEqual([])
    expect(due([email("jo@gmail.com")], { live: false })).toEqual([])
  })

  it("stays quiet for an email on the business's own domain", () => {
    expect(due([email("hello@doxcleaning.co.uk")])).toEqual([])
  })

  it("is never offered twice", () => {
    expect(due([email("jo@gmail.com")], { given: ["business_email"] })).toEqual(
      []
    )
  })
})

describe("tips: a phone number from another part of the country", () => {
  it("fires for a London number on a Leeds business, domain or none", () => {
    expect(
      due([phone("+442079460000"), area("Leeds")], { domains: [] })
    ).toEqual(["local_phone"])
  })

  it("stays quiet when the code matches the area, even in a longer list of places", () => {
    expect(due([phone("+441132000000"), area("Leeds")])).toEqual([])
    expect(
      due([
        phone("+441612000000"),
        fact("service_area.text", { text: "Leeds, Manchester and Bradford" }),
      ])
    ).toEqual([])
  })

  it("stays quiet for a mobile, a non-geographic number or a code it does not know", () => {
    expect(due([phone("+447700900123"), area("Leeds")])).toEqual([])
    expect(due([phone("+443001234567"), area("Leeds")])).toEqual([])
    expect(due([phone("+441904000000"), area("Leeds")])).toEqual([])
  })

  it("stays quiet when it cannot tell where the business is", () => {
    expect(due([phone("+442079460000")])).toEqual([])
    expect(due([phone("+442079460000"), area("Croydon")])).toEqual([])
  })

  it("stays quiet before the site is live and once given", () => {
    const facts = [phone("+442079460000"), area("Leeds")]
    expect(due(facts, { live: false })).toEqual([])
    expect(due(facts, { given: ["local_phone"] })).toEqual([])
  })

  it("lists both tips when both apply", () => {
    expect(
      due([email("jo@yahoo.co.uk"), phone("+442079460000"), area("Leeds")])
    ).toEqual(["business_email", "local_phone"])
  })
})
