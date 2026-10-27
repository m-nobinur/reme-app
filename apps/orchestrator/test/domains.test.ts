import { afterEach, describe, expect, it, vi } from "vitest"
import {
  alreadyPointsAtUs,
  CAA_FOR_US,
  CNAME_TARGET,
  type CustomHostname,
  deleteHostname,
  detectProvider,
  domainCheck,
  ensureHostname,
  getHostname,
  type Inspection,
  inspect,
  recordsFor,
  SETTINGS_MAX_BYTES,
  settingsBase,
  stillToAdd,
} from "../src/domains.ts"
import { stubNet } from "./fixtures/domains.ts"

const txtAnswer = (apex: string, value: string) => ({
  Status: 0,
  Answer: [
    { name: `_domainconnect.${apex}`, type: 16, TTL: 60, data: `"${value}"` },
  ],
})

const soaIn = (host: string, zone: string, status = 0) => ({
  [`${host} SOA`]: {
    Status: status,
    Authority: [
      {
        name: zone,
        type: 6,
        TTL: 600,
        data: "ns47.domaincontrol.com. dns.jomax.net. 1 1 1 1 1",
      },
    ],
  },
})

const urls = (fetched: ReturnType<typeof stubNet>) =>
  fetched.mock.calls.map(([u]) => String(u))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("provider detection", () => {
  it("names GoDaddy and links our GoDaddy DNS page", async () => {
    stubNet()
    expect(
      await detectProvider("sparklecleanbristol.co.uk", [
        "ns47.domaincontrol.com",
      ])
    ).toEqual({
      name: "GoDaddy",
      settings_url: "https://dcc.godaddy.com/manage/dns",
    })
  })

  it("names 123 Reg through secureserver, which the nameservers alone would call GoDaddy", async () => {
    stubNet()
    expect(
      await detectProvider("sparkleclean123.co.uk", ["ns53.domaincontrol.com"])
    ).toEqual({
      name: "123 Reg",
      settings_url: "https://dcc.secureserver.net/manage/dns",
    })
  })

  it("names Cloudflare and links the dashboard, though its answer has no urlControlPanel", async () => {
    stubNet()
    expect(
      await detectProvider("sparkleclean.co.uk", ["etienne.ns.cloudflare.com"])
    ).toEqual({
      name: "Cloudflare",
      settings_url: "https://dash.cloudflare.com/",
    })
  })

  it.each([
    ["ns.123-reg.co.uk", "123-reg", "https://www.123-reg.co.uk/secure/"],
    ["ns1043.ui-dns.com", "IONOS", "https://my.ionos.co.uk/domains"],
    [
      "dns1.registrar-servers.com",
      "Namecheap",
      "https://ap.www.namecheap.com/domains/list/",
    ],
  ])(
    "names the owner's DNS host from its nameserver %s",
    async (ns, name, link) => {
      stubNet()
      expect(await detectProvider("plain.co.uk", [ns])).toEqual({
        name,
        settings_url: link,
      })
    }
  )

  it("gives a provider that discovery names without a page the page of its nameservers", async () => {
    stubNet(
      {
        "https://dc.ionos.example/v2/plain.co.uk/settings": Response.json({
          providerDisplayName: "IONOS",
          urlControlPanel: "https://elsewhere.example/dns",
        }),
      },
      {
        "_domainconnect.plain.co.uk TXT": txtAnswer(
          "plain.co.uk",
          "dc.ionos.example"
        ),
      }
    )
    expect(await detectProvider("plain.co.uk", ["ns1043.ui-dns.com"])).toEqual({
      name: "IONOS",
      settings_url: "https://my.ionos.co.uk/domains",
    })
  })

  it("gives an unknown provider its name and no button", async () => {
    stubNet(
      {
        "https://dc.example-dns.net/v2/unknown.co.uk/settings": Response.json({
          providerDisplayName: "Example DNS",
          urlControlPanel: "https://panel.example-dns.net/dns",
        }),
      },
      {
        "_domainconnect.unknown.co.uk TXT": txtAnswer(
          "unknown.co.uk",
          "dc.example-dns.net"
        ),
      }
    )
    expect(
      await detectProvider("unknown.co.uk", ["ns1.example-dns.net"])
    ).toEqual({
      name: "Example DNS",
    })
  })

  it.each([
    "https://dcc.godaddy.com.evil.example/manage/dns",
    "http://dcc.godaddy.com/manage/dns",
    "javascript:alert(1)//dcc.godaddy.com",
    "https://evil.example/?next=https://dcc.godaddy.com/manage/dns",
  ])("never shows an off-allowlist urlControlPanel: %s", async (panel) => {
    stubNet(
      {
        "https://dc.example-dns.net/v2/unknown.co.uk/settings": Response.json({
          providerDisplayName: "GoDaddy",
          urlControlPanel: panel,
        }),
      },
      {
        "_domainconnect.unknown.co.uk TXT": txtAnswer(
          "unknown.co.uk",
          "dc.example-dns.net"
        ),
      }
    )
    const provider = await detectProvider("unknown.co.uk", [])
    expect(provider).toEqual({ name: "GoDaddy" })
  })

  it("strips control characters from the name and caps it at 80", async () => {
    stubNet(
      {
        "https://dc.example-dns.net/v2/unknown.co.uk/settings": Response.json({
          providerDisplayName: `Example\u0000‮ DNS ${"x".repeat(200)}`,
        }),
      },
      {
        "_domainconnect.unknown.co.uk TXT": txtAnswer(
          "unknown.co.uk",
          "dc.example-dns.net"
        ),
      }
    )
    const provider = await detectProvider("unknown.co.uk", [])
    expect(provider?.name.startsWith("Example DNS x")).toBe(true)
    expect(provider?.name).toHaveLength(80)
  })

  it("falls back to the nameserver table when the TXT is not Domain Connect", async () => {
    const fetched = stubNet()
    expect(
      await detectProvider("wildcard.co.uk", ["ns53.domaincontrol.com."])
    ).toEqual({
      name: "GoDaddy",
      settings_url: "https://dcc.godaddy.com/manage/dns",
    })
    expect(
      urls(fetched).every((u) => u.startsWith("https://cloudflare-dns.com/"))
    ).toBe(true)
  })

  it("gives nothing when neither discovery nor the nameservers know the provider", async () => {
    stubNet()
    expect(
      await detectProvider("nobody.co.uk", ["ns1.example-dns.net"])
    ).toBeNull()
  })

  it.each([
    "127.0.0.1",
    "10.0.0.1/v2",
    "0x7f.1",
    "[::1]",
    "x.remeai.co.uk",
    "remeai.co.uk",
    "http://dc.example-dns.net",
    "dc.example-dns.net:8443",
    "user@dc.example-dns.net",
    "localhost",
    "dc.example-dns.net/../admin",
  ])(
    "refuses the settings host %s and fetches nothing from it",
    async (value) => {
      expect(settingsBase(value)).toBeNull()
      const fetched = stubNet(
        {},
        {
          "_domainconnect.unknown.co.uk TXT": txtAnswer("unknown.co.uk", value),
        }
      )
      expect(await detectProvider("unknown.co.uk", [])).toBeNull()
      expect(
        urls(fetched).every((u) => u.startsWith("https://cloudflare-dns.com/"))
      ).toBe(true)
    }
  )

  it("asks with redirect manual and a timeout, and ignores a redirect", async () => {
    const fetched = stubNet(
      {
        "https://dc.example-dns.net/v2/unknown.co.uk/settings": new Response(
          null,
          {
            status: 302,
            headers: { location: "https://dcc.godaddy.com/manage/dns" },
          }
        ),
      },
      {
        "_domainconnect.unknown.co.uk TXT": txtAnswer(
          "unknown.co.uk",
          "dc.example-dns.net"
        ),
      }
    )
    expect(await detectProvider("unknown.co.uk", [])).toBeNull()
    const init = fetched.mock.calls.find(([u]) =>
      String(u).includes("example-dns")
    )?.[1] as RequestInit | undefined
    expect(init?.redirect).toBe("manual")
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it("refuses a settings body over the cap", async () => {
    const big = JSON.stringify({
      providerDisplayName: "Big",
      pad: "x".repeat(SETTINGS_MAX_BYTES),
    })
    stubNet(
      {
        "https://dc.example-dns.net/v2/unknown.co.uk/settings": () =>
          new Response(big),
      },
      {
        "_domainconnect.unknown.co.uk TXT": txtAnswer(
          "unknown.co.uk",
          "dc.example-dns.net"
        ),
      }
    )
    expect(await detectProvider("unknown.co.uk", [])).toBeNull()
  })
})

describe("the DoH inspector", () => {
  it("finds the apex from a www SOA and reads the records at both hosts, in nine queries", async () => {
    const fetched = stubNet()
    const inspection = await inspect("www.sparklecleanbristol.co.uk")
    // SOA, NS, A and AAAA at both hosts and at our target, CAA. MX only
    // decides whether a missing subdomain's zone is in use.
    const asked = fetched.mock.calls.map(([u]) => {
      const q = new URL(String(u)).searchParams
      return `${q.get("name")} ${q.get("type")}`
    })
    expect(asked).toHaveLength(9)
    expect(asked.filter((a) => a.endsWith(" MX"))).toEqual([])
    expect(inspection).toEqual({
      apex: "sparklecleanbristol.co.uk",
      nameservers: ["ns47.domaincontrol.com", "ns48.domaincontrol.com"],
      onCloudflare: false,
      hosts: {
        "sparklecleanbristol.co.uk": { a: ["192.0.2.10"], aaaa: [] },
        "www.sparklecleanbristol.co.uk": { a: ["192.0.2.10"], aaaa: [] },
      },
      target: ["104.21.0.10", "172.67.0.10", "2606:4700:3030::10"],
      caa: [
        '0 issue "digicert.com"',
        '0 iodef "mailto:it@sparklecleanbristol.co.uk"',
      ],
    })
  })

  it("finds a subdomain's own zone when its CNAME to us already exists, not the target's", async () => {
    stubNet(
      {},
      {
        // The live answer for site.mnobinur.dev on 2026-10-16: the SOA query
        // follows the CNAME, so its authority names our own zone.
        "book.sparklecleanbristol.co.uk SOA": {
          Status: 0,
          Answer: [
            {
              name: "book.sparklecleanbristol.co.uk",
              type: 5,
              TTL: 300,
              data: "domains.remeai.co.uk.",
            },
          ],
          Authority: [
            {
              name: "remeai.co.uk",
              type: 6,
              TTL: 1800,
              data: "ns. dns. 1 1 1 1 1",
            },
          ],
        },
      }
    )
    const inspection = await inspect("book.sparklecleanbristol.co.uk")
    expect(inspection.apex).toBe("sparklecleanbristol.co.uk")
    expect(inspection.sub).toBe("book.sparklecleanbristol.co.uk")
  })

  it("reads a subdomain alone and asks for its own CNAME, with no www and no apex line", async () => {
    stubNet(
      {},
      soaIn("book.sparklecleanbristol.co.uk", "sparklecleanbristol.co.uk")
    )
    const inspection = await inspect("book.sparklecleanbristol.co.uk")
    expect(inspection.apex).toBe("sparklecleanbristol.co.uk")
    expect(inspection.sub).toBe("book.sparklecleanbristol.co.uk")
    expect(Object.keys(inspection.hosts)).toEqual([
      "book.sparklecleanbristol.co.uk",
    ])
    expect(recordsFor({ inspection, apex: "alias" })).toEqual([
      { type: "CNAME", name: "book", value: CNAME_TARGET },
      { type: "CAA", name: "@", value: CAA_FOR_US },
    ])
  })

  it("takes a subdomain with no record yet when its zone is in use", async () => {
    stubNet(
      {},
      soaIn("book.sparklecleanbristol.co.uk", "sparklecleanbristol.co.uk", 3)
    )
    const inspection = await inspect("book.sparklecleanbristol.co.uk")
    expect(inspection.sub).toBe("book.sparklecleanbristol.co.uk")
    expect(inspection.hosts["book.sparklecleanbristol.co.uk"]).toEqual({
      a: [],
      aaaa: [],
    })
  })

  it("takes a subdomain under a registered domain with nothing on it yet", async () => {
    vi.stubGlobal("caches", {
      default: { match: async () => undefined, put: async () => undefined },
    })
    stubNet(
      {
        "https://data.iana.org/rdap/dns.json": () =>
          Response.json({
            services: [[["uk"], ["https://rdap.nominet.uk/uk/"]]],
          }),
        "https://rdap.nominet.uk/uk/domain/brightclean.co.uk": () =>
          Response.json({ entities: [] }),
      },
      soaIn("book.brightclean.co.uk", "brightclean.co.uk", 3)
    )
    const inspection = await inspect("book.brightclean.co.uk")
    expect(inspection.sub).toBe("book.brightclean.co.uk")
  })

  it("refuses a name that does not exist rather than taking the registry's zone", async () => {
    stubNet()
    await expect(inspect("nowhere-at-all.co.uk")).rejects.toThrow(
      "domain.not_found"
    )
  })

  it("takes a host's own CNAME from the chain, not the target's addresses", async () => {
    stubNet(
      {},
      {
        "www.sparklecleanbristol.co.uk A": {
          Status: 0,
          Answer: [
            {
              name: "www.sparklecleanbristol.co.uk",
              type: 5,
              TTL: 300,
              data: "domains.remeai.co.uk.",
            },
            {
              name: "domains.remeai.co.uk",
              type: 1,
              TTL: 300,
              data: "104.21.0.10",
            },
          ],
        },
      }
    )
    const inspection = await inspect("www.sparklecleanbristol.co.uk")
    expect(inspection.hosts["www.sparklecleanbristol.co.uk"]).toEqual({
      cname: "domains.remeai.co.uk",
      a: [],
      aaaa: [],
    })
  })
})

const APEX = "sparklecleanbristol.co.uk"
const WWW = `www.${APEX}`

function fakeInspection(overrides: Partial<Inspection> = {}): Inspection {
  return {
    apex: APEX,
    nameservers: ["ns47.domaincontrol.com"],
    onCloudflare: false,
    hosts: {
      [APEX]: { a: ["192.0.2.10"], aaaa: [] },
      [WWW]: { cname: CNAME_TARGET, a: [], aaaa: [] },
    },
    target: ["104.21.0.10", "172.67.0.10"],
    caa: [],
    ...overrides,
  }
}

const hostname = (
  host: string,
  status = "active",
  ssl = "active"
): CustomHostname => ({
  id: `id-${host}`,
  hostname: host,
  status,
  ssl: { status: ssl },
})

describe("the domain check", () => {
  it("is valid only when DNS reaches us, the hostname is active and the certificate is issued", () => {
    expect(
      domainCheck(fakeInspection(), [{ host: WWW, hostname: hostname(WWW) }])
    ).toEqual({
      status: "valid",
    })
  })

  it("reports a planted A record on www as the one conflict", () => {
    const planted = fakeInspection({
      hosts: {
        [APEX]: { a: [], aaaa: [] },
        [WWW]: { a: ["192.0.2.10"], aaaa: [] },
      },
    })
    expect(
      domainCheck(planted, [
        { host: WWW, hostname: hostname(WWW, "pending", "pending_validation") },
      ])
    ).toEqual({
      status: "conflicting_record",
      conflicts: [{ type: "A", name: "www", value: "192.0.2.10" }],
    })
  })

  it("reports a www CNAME to an old host as the conflict", () => {
    const old = fakeInspection({
      hosts: { [WWW]: { cname: "old-site.wixdns.net", a: [], aaaa: [] } },
    })
    expect(
      domainCheck(old, [{ host: WWW, hostname: hostname(WWW, "pending") }])
    ).toEqual({
      status: "conflicting_record",
      conflicts: [{ type: "CNAME", name: "www", value: "old-site.wixdns.net" }],
    })
  })

  it("reports CAA that allows none of our CAs, and not CAA that allows one", () => {
    const blocked = fakeInspection({
      caa: ['0 issue "digicert.com"', '0 iodef "mailto:x@y.z"'],
    })
    expect(
      domainCheck(blocked, [{ host: WWW, hostname: hostname(WWW) }])
    ).toEqual({
      status: "conflicting_record",
      conflicts: [{ type: "CAA", name: "@", value: '0 issue "digicert.com"' }],
    })
    for (const caa of [
      ['0 issue "digicert.com"', '0 issue "letsencrypt.org"'],
      ['0 issue "pki.goog; cansignhttpexchanges=yes"'],
      ['0 iodef "mailto:x@y.z"'],
    ]) {
      expect(
        domainCheck(fakeInspection({ caa }), [
          { host: WWW, hostname: hostname(WWW) },
        ])
      ).toEqual({
        status: "valid",
      })
    }
  })

  it("decides in dub's order", () => {
    const empty = fakeInspection({ hosts: { [WWW]: { a: [], aaaa: [] } } })
    expect(domainCheck(empty, [{ host: WWW, hostname: null }])).toEqual({
      status: "not_found",
    })
    expect(
      domainCheck(empty, [{ host: WWW, hostname: hostname(WWW, "pending") }])
    ).toEqual({
      status: "pending_verification",
    })
    // Active at Cloudflare but the record is gone: the owner moved it.
    expect(
      domainCheck(empty, [{ host: WWW, hostname: hostname(WWW) }])
    ).toEqual({
      status: "invalid_configuration",
    })
    expect(
      domainCheck(fakeInspection(), [
        { host: WWW, hostname: hostname(WWW, "active", "pending_validation") },
      ])
    ).toEqual({ status: "pending_certificate" })
  })

  it("takes a flattened apex ALIAS as ours and an old apex A as a conflict", () => {
    const hosts = [
      { host: APEX, hostname: hostname(APEX) },
      { host: WWW, hostname: hostname(WWW) },
    ]
    const flattened = fakeInspection({
      hosts: {
        [APEX]: { a: ["104.21.0.10", "172.67.0.10"], aaaa: [] },
        [WWW]: { cname: CNAME_TARGET, a: [], aaaa: [] },
      },
    })
    expect(domainCheck(flattened, hosts)).toEqual({ status: "valid" })
    const mixed = fakeInspection({
      hosts: {
        [APEX]: { a: ["104.21.0.10", "192.0.2.10"], aaaa: [] },
        [WWW]: { cname: CNAME_TARGET, a: [], aaaa: [] },
      },
    })
    expect(domainCheck(mixed, hosts)).toEqual({
      status: "conflicting_record",
      conflicts: [{ type: "A", name: "@", value: "192.0.2.10" }],
    })
  })

  it("does not call the owner's own Cloudflare proxy addresses a conflict", () => {
    const proxied = fakeInspection({
      onCloudflare: true,
      hosts: { [WWW]: { a: ["104.16.1.1"], aaaa: [] } },
    })
    expect(
      domainCheck(proxied, [{ host: WWW, hostname: hostname(WWW, "pending") }])
    ).toEqual({
      status: "pending_verification",
    })
  })
})

describe("a name that already reaches us", () => {
  it("is a CNAME to our target or our addresses, and on Cloudflare only a visible CNAME", () => {
    // `www` CNAMEs to us: a record left from an earlier claim.
    expect(alreadyPointsAtUs(fakeInspection())).toBe(true)
    const elsewhere = { [APEX]: { a: ["192.0.2.10"], aaaa: [] } }
    expect(alreadyPointsAtUs(fakeInspection({ hosts: elsewhere }))).toBe(false)
    const flattened = { [APEX]: { a: ["104.21.0.10"], aaaa: [] } }
    expect(alreadyPointsAtUs(fakeInspection({ hosts: flattened }))).toBe(true)
    // The owner's own proxy shows Cloudflare addresses whatever the record is.
    expect(
      alreadyPointsAtUs(
        fakeInspection({
          onCloudflare: true,
          hosts: { [WWW]: { a: ["104.16.1.1"], aaaa: [] } },
        })
      )
    ).toBe(false)
    expect(
      alreadyPointsAtUs(
        fakeInspection({
          onCloudflare: true,
          hosts: { [WWW]: { cname: CNAME_TARGET, a: [], aaaa: [] } },
        })
      )
    ).toBe(true)
  })
})

describe("the records list", () => {
  it("forward: www CNAME only, the apex is the provider's redirect", () => {
    expect(
      recordsFor({ inspection: fakeInspection(), apex: "forward" })
    ).toEqual([{ type: "CNAME", name: "www", value: CNAME_TARGET }])
  })

  it("alias: www CNAME and an apex ALIAS", () => {
    expect(recordsFor({ inspection: fakeInspection(), apex: "alias" })).toEqual(
      [
        { type: "CNAME", name: "www", value: CNAME_TARGET },
        { type: "ALIAS", name: "@", value: CNAME_TARGET },
      ]
    )
  })

  it("adds a CAA line for us when the domain's CAA blocks our CAs", () => {
    const blocked = fakeInspection({ caa: ['0 issue "digicert.com"'] })
    expect(recordsFor({ inspection: blocked, apex: "forward" })).toEqual([
      { type: "CNAME", name: "www", value: CNAME_TARGET },
      { type: "CAA", name: "@", value: CAA_FOR_US },
    ])
  })

  it("lists only the records DNS does not already show", () => {
    const listed = (inspection: Inspection) =>
      stillToAdd(recordsFor({ inspection, apex: "alias" }), inspection)
    // www already CNAMEs to us: only the apex ALIAS and the CAA line remain.
    const blocked = fakeInspection({ caa: ['0 issue "digicert.com"'] })
    expect(listed(blocked).map((r) => r.type)).toEqual(["ALIAS", "CAA"])
    // An old A at www is in the way, so its CNAME is still to add.
    const old = fakeInspection({
      hosts: {
        [APEX]: { a: ["192.0.2.10"], aaaa: [] },
        [WWW]: { a: ["192.0.2.10"], aaaa: [] },
      },
    })
    expect(listed(old).map((r) => r.type)).toEqual(["CNAME", "ALIAS"])
    // The apex already answering as our target needs no ALIAS.
    const flat = fakeInspection({
      hosts: {
        [APEX]: { a: ["104.21.0.10"], aaaa: [] },
        [WWW]: { cname: CNAME_TARGET, a: [], aaaa: [] },
      },
    })
    expect(listed(flat)).toEqual([])
  })
})

describe("the custom hostname client", () => {
  const env = { CF_DOMAINS_TOKEN: "token", CF_DOMAINS_ZONE_ID: "zone" }
  const base =
    "https://api.cloudflare.com/client/v4/zones/zone/custom_hostnames"
  const envelope = (result: unknown) =>
    Response.json({ success: true, errors: [], messages: [], result })

  it("refuses to run without its token and zone", async () => {
    stubNet()
    await expect(ensureHostname({}, WWW, {})).rejects.toThrow(
      "domains.not_configured"
    )
  })

  it("creates with HTTP DV validation when the hostname is new", async () => {
    const created = hostname(WWW, "pending", "initializing")
    const fetched = stubNet({
      [`${base}?hostname.exact=${WWW}`]: envelope([]),
      [base]: envelope(created),
    })
    expect(await ensureHostname(env, WWW, {})).toEqual(created)
    const post = fetched.mock.calls.find(
      ([, request]) => request?.method === "POST"
    )
    const init = post?.[1] ?? {}
    expect(JSON.parse(String(init.body))).toEqual({
      hostname: WWW,
      ssl: { method: "http", type: "dv" },
    })
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer token")
  })

  it("adopts the hostname whose id the claim holds instead of creating a second", async () => {
    const existing = { ...hostname(WWW, "pending"), id: "id-held" }
    const fetched = stubNet({
      [`${base}?hostname.exact=${WWW}`]: envelope([existing]),
    })
    expect(await ensureHostname(env, WWW, { id: "id-held" })).toEqual(existing)
    expect(fetched).toHaveBeenCalledTimes(1)
  })

  it("refuses one it does not hold, however new, and neither reuses nor deletes it", async () => {
    // Even one made after the claim: it may be the other environment's.
    const other = { ...hostname(WWW), id: "id-other" }
    const fetched = stubNet({
      [`${base}?hostname.exact=${WWW}`]: envelope([other]),
    })
    await expect(ensureHostname(env, WWW, {})).rejects.toThrow(
      "domain.hostname_held"
    )
    expect(fetched).toHaveBeenCalledTimes(1)
  })

  it("surfaces Cloudflare's error code", async () => {
    stubNet({
      [`${base}?hostname.exact=${WWW}`]: Response.json(
        {
          success: false,
          errors: [{ code: 1456, message: "SaaS not enabled" }],
          messages: [],
          result: null,
        },
        { status: 403 }
      ),
    })
    await expect(ensureHostname(env, WWW, {})).rejects.toThrow(
      "cloudflare.1456"
    )
  })

  it("reads a gone hostname as null and deletes one already gone without failing", async () => {
    stubNet({
      [`${base}/gone`]: () =>
        Response.json(
          { success: false, errors: [{ code: 1436 }] },
          { status: 404 }
        ),
    })
    expect(await getHostname(env, "gone")).toBeNull()
    await expect(deleteHostname(env, "gone")).resolves.toBeUndefined()
  })
})
