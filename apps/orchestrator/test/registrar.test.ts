import { afterEach, describe, expect, it, vi } from "vitest"
import {
  attachHostname,
  candidates,
  checkDomains,
  ensureZone,
  getRegistration,
  register,
  registrantProblem,
  registrantRules,
  registrationStatus,
  searchDomains,
  sellable,
  setAutoRenew,
} from "../src/registrar.ts"
import {
  ACCOUNT,
  CHECK_SANDBOX,
  EXTENSION_CO_UK,
  EXTENSION_COM,
  envelope,
  LIVE,
  NOT_FOUND,
  REG_PENDING,
  REGISTRATION,
  SANDBOX,
  WORKER_DOMAIN,
  ZONE,
} from "./fixtures/registrar.ts"

const sandbox = { CF_DOMAINS_TOKEN: "t", CF_ACCOUNT_ID: ACCOUNT }
const live = { ...sandbox, REGISTRAR_API: "registrar" }

type Call = { url: string; method: string; body: unknown; headers: Headers }

/** `fetch` answered by `METHOD url` from `routes`; every call recorded. */
function stub(routes: Record<string, unknown | (() => Response)>) {
  const calls: Call[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? "GET"
      calls.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: new Headers(init?.headers),
      })
      const route = routes[`${method} ${url}`]
      if (route === undefined) throw new Error(`unexpected ${method} ${url}`)
      if (typeof route === "function") return (route as () => Response)()
      return Response.json(route)
    })
  )
  return calls
}

afterEach(() => vi.unstubAllGlobals())

const sparkle = {
  name: "Jane Smith",
  organization: "Sparkle Clean",
  email: "jane@example.com",
  phone: "+44.7700900123",
  address: {
    street: "12 Mill Lane",
    city: "Bristol",
    state: "Bristol",
    postal_code: "BS1 4AB",
    country_code: "GB",
  },
}

describe("the registrar client", () => {
  it("checks through the sandbox unless REGISTRAR_API says registrar", async () => {
    const calls = stub({ [`POST ${SANDBOX}/domain-check`]: CHECK_SANDBOX })
    const checked = await checkDomains(sandbox, ["sparklecleanbristol.com"])
    expect(calls[0]?.body).toEqual({ domains: ["sparklecleanbristol.com"] })
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer t")
    expect(checked.map((c) => c.name)).toContain("sparklecleanbristol.com")

    vi.unstubAllGlobals()
    const liveCalls = stub({ [`POST ${LIVE}/domain-check`]: CHECK_SANDBOX })
    await checkDomains(live, ["sparklecleanbristol.com"])
    expect(liveCalls[0]?.url).toBe(`${LIVE}/domain-check`)
  })

  it("refuses more than 20 names and calls nothing for none", async () => {
    const calls = stub({})
    expect(await checkDomains(sandbox, [])).toEqual([])
    await expect(
      checkDomains(
        sandbox,
        Array.from({ length: 21 }, (_, i) => `a${i}.com`)
      )
    ).rejects.toThrow("registrar.too_many")
    expect(calls).toEqual([])
  })

  it("fails as not configured without the token or the account", async () => {
    await expect(checkDomains({}, ["a.com"])).rejects.toThrow(
      "domains.not_configured"
    )
  })

  it("searches in the table's endings and keeps only those", async () => {
    const calls = stub({
      [`GET ${SANDBOX}/domain-search?q=sparkle&extensions=co.uk%2Cuk%2Ccom%2Cnet&limit=10`]:
        envelope({
          domains: [
            { name: "sparkle.com", registrable: true },
            { name: "sparkle.org", registrable: true },
          ],
        }),
    })
    expect(await searchDomains(sandbox, "sparkle")).toEqual(["sparkle.com"])
    expect(calls).toHaveLength(1)
  })

  it("sells only registrable standard names under the TLD's cap", () => {
    const [coUk, uk, com, taken] = (
      CHECK_SANDBOX.result as { domains: Parameters<typeof sellable>[0][] }
    ).domains as [never, never, never, never]
    expect(sellable(coUk)).toBeNull()
    expect(sellable(uk)).toBeNull()
    expect(sellable(com)).toBe(10.46)
    expect(sellable(taken)).toBeNull()
    const priced = (cost: string, tier = "standard") => ({
      name: "a.co.uk",
      registrable: true,
      tier: tier as "standard",
      pricing: { currency: "USD", registration_cost: cost, renewal_cost: cost },
    })
    expect(sellable(priced("5.30"))).toBe(5.3)
    expect(sellable(priced("6.51"))).toBeNull()
    expect(sellable(priced("5.30", "premium"))).toBeNull()
    expect(sellable({ ...priced("5.30"), name: "a.org" })).toBeNull()
    expect(sellable({ ...priced("5.30"), name: "book.a.co.uk" })).toBeNull()
  })

  it("reads .co.uk's registrant rules from Cloudflare's schema, and none for .com", async () => {
    stub({
      [`GET ${LIVE}/extensions/co.uk`]: EXTENSION_CO_UK,
      [`GET ${LIVE}/extensions/com`]: EXTENSION_COM,
    })
    const coUk = await registrantRules(live, "co.uk")
    expect(coUk.registrantTypes).toEqual(
      expect.arrayContaining(["STRA", "LTD", "LLP", "PTNR", "IND"])
    )
    expect(coUk.companyNumberFor).toEqual(
      expect.arrayContaining(["LTD", "LLP"])
    )
    expect(coUk.organizationRequired).toBe(true)
    expect(registrantProblem(coUk, { registrant: sparkle })).toBe(
      "registrant_type"
    )
    expect(
      registrantProblem(coUk, { registrant: sparkle, registrant_type: "LTD" })
    ).toBe("company_number")
    expect(
      registrantProblem(coUk, { registrant: sparkle, registrant_type: "STRA" })
    ).toBeNull()
    expect(
      registrantProblem(coUk, {
        registrant: { ...sparkle, organization: undefined },
        registrant_type: "STRA",
      })
    ).toBe("organization")

    const com = await registrantRules(live, "com")
    expect(com).toEqual({
      registrantTypes: [],
      companyNumberFor: [],
      organizationRequired: false,
    })
    expect(registrantProblem(com, { registrant: sparkle })).toBeNull()
  })

  it("registers asynchronously with the registrant, one year, auto-renew and redaction", async () => {
    const name = "sparklecleanbristol.co.uk"
    const calls = stub({
      [`GET ${SANDBOX}/registrations/${name}`]: () =>
        Response.json(NOT_FOUND, { status: 404 }),
      [`POST ${SANDBOX}/registrations`]: () =>
        Response.json(REG_PENDING(name), { status: 202 }),
    })
    const status = await register(sandbox, {
      name,
      registrant: sparkle,
      registrant_type: "STRA",
    })
    expect(status.state).toBe("in_progress")
    const post = calls[1]
    expect(post?.headers.get("prefer")).toBe("respond-async")
    expect(post?.body).toEqual({
      domain_name: name,
      years: 1,
      auto_renew: true,
      privacy_mode: "redaction",
      contacts: {
        registrant: {
          email: sparkle.email,
          phone: sparkle.phone,
          postal_info: {
            name: sparkle.name,
            organization: sparkle.organization,
            address: sparkle.address,
          },
        },
      },
      contact_extensions: { registrant_type: "STRA" },
    })
  })

  it("never registers twice: a name the account holds reads its status instead", async () => {
    const name = "sparklecleanbristol.com"
    const calls = stub({
      [`GET ${SANDBOX}/registrations/${name}`]: REGISTRATION(name),
      [`GET ${SANDBOX}/registrations/${name}/registration-status`]:
        REG_PENDING(name),
    })
    await register(sandbox, { name, registrant: sparkle })
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET"])
  })

  it("reads a registration, null when there is none, and its status", async () => {
    const name = "sparklecleanbristol.com"
    stub({
      [`GET ${SANDBOX}/registrations/${name}`]: REGISTRATION(name),
      [`GET ${SANDBOX}/registrations/gone.com`]: () =>
        Response.json(NOT_FOUND, { status: 404 }),
      [`GET ${SANDBOX}/registrations/${name}/registration-status`]:
        REG_PENDING(name),
    })
    expect((await getRegistration(sandbox, name))?.expires_at).toBe(
      "2027-10-16T12:00:05Z"
    )
    expect(await getRegistration(sandbox, "gone.com")).toBeNull()
    expect((await registrationStatus(sandbox, name)).completed).toBe(false)
  })

  it("switches auto-renew with a PATCH", async () => {
    const name = "sparklecleanbristol.com"
    const calls = stub({
      [`PATCH ${SANDBOX}/registrations/${name}`]: REG_PENDING(name),
    })
    await setAutoRenew(sandbox, name, false)
    expect(calls[0]?.body).toEqual({ auto_renew: false })
  })

  it("finds the bought zone or makes it, then attaches a host to the router", async () => {
    const name = "sparkleclean.co.uk"
    const zones = `https://api.cloudflare.com/client/v4/zones`
    const calls = stub({
      [`GET ${zones}?name=${name}&account.id=${ACCOUNT}`]: envelope([]),
      [`POST ${zones}`]: ZONE("z1", name),
      [`PUT https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/domains`]:
        WORKER_DOMAIN(name, "z1"),
    })
    expect(await ensureZone(live, name)).toBe("z1")
    expect(calls[1]?.body).toEqual({
      name,
      account: { id: ACCOUNT },
      type: "full",
    })
    await attachHostname(live, {
      hostname: name,
      zoneId: "z1",
      service: "reme-router",
    })
    expect(calls[2]?.body).toEqual({
      hostname: name,
      zone_id: "z1",
      service: "reme-router",
    })
  })

  it("adopts a zone registration already made", async () => {
    const name = "sparkleclean.co.uk"
    const calls = stub({
      [`GET https://api.cloudflare.com/client/v4/zones?name=${name}&account.id=${ACCOUNT}`]:
        envelope([{ id: "z0", name }]),
    })
    expect(await ensureZone(live, name)).toBe("z0")
    expect(calls).toHaveLength(1)
  })
})

describe("the name ranker", () => {
  it("ranks the plan's example: exact .co.uk first, brand plus town next, no trade when the name says it", () => {
    const ranked = candidates({
      name: "Sparkle Clean Ltd",
      town: "Bristol",
      trade: "Cleaning",
    })
    expect(ranked[0]?.name).toBe("sparkleclean.co.uk")
    expect(ranked.map((r) => r.name)).toEqual([
      "sparkleclean.co.uk",
      "sparkleclean.com",
      "sparkleclean.uk",
      "sparkleclean.net",
      "sparklecleanbristol.co.uk",
      "sparklecleanbristol.com",
      "sparklecleanbristol.uk",
      "sparkleclean-bristol.co.uk",
      "sparklecleanbristol.net",
      "sparkleclean-bristol.com",
      "sparkleclean-bristol.uk",
      "sparkleclean-bristol.net",
    ])
    expect(ranked.some((r) => r.name.includes("cleaning"))).toBe(false)
    expect(ranked[0]?.why).toMatch(/business name/)
  })

  it("adds the trade when the name does not say it, and stays within one check", () => {
    const ranked = candidates({
      name: "The Smith & Daughters Co.",
      town: "Bath, Somerset",
      trade: "Cleaning",
    })
    expect(ranked.map((r) => r.name)).toContain(
      "smithanddaughterscleaning.co.uk"
    )
    expect(ranked.map((r) => r.name)).toContain("smithanddaughters-bath.co.uk")
    expect(ranked.length).toBeLessThanOrEqual(20)
  })

  it("strips accents and punctuation and gives nothing for a name with no letters", () => {
    expect(candidates({ name: "Café Fresh!" })[0]?.name).toBe("cafefresh.co.uk")
    expect(candidates({ name: "Ltd" })).toEqual([])
  })

  it("marks digits and length down", () => {
    const [top] = candidates({ name: "Clean 4 U" })
    expect(top?.score).toBe(40 + 30 - 20)
  })
})
