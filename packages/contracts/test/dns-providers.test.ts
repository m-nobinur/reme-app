import { describe, expect, it } from "vitest"
import {
  DNS_PROVIDERS,
  dnsProvider,
  registrarIn,
} from "../src/dns-providers.ts"

/** example.co.uk for www.example.co.uk, example.com for a.b.example.com. */
const registrable = (url: string) => {
  const labels = new URL(url).hostname.split(".")
  return labels.slice(labels.at(-2) === "co" ? -3 : -2).join(".")
}

describe("the DNS provider registry", () => {
  it.each(DNS_PROVIDERS.map((p) => [p.id, p] as const))(
    "%s links over https to its own domain",
    (_, provider) => {
      const settings = provider.settingsUrl("example.co.uk")
      for (const url of [settings, provider.helpUrl]) {
        expect(url).toMatch(/^https:\/\/[^\s]+$/)
        expect(registrable(url)).not.toBe("remeai.co.uk")
      }
      expect(registrable(settings)).toBe(registrable(provider.helpUrl))
    }
  )

  it("gives every provider a matcher, a unique id and a mark id or none", () => {
    const ids = DNS_PROVIDERS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const p of DNS_PROVIDERS) {
      expect(p.id).toMatch(/^[a-z0-9-]{1,40}$/)
      expect(p.nameservers.length + p.registrars.length).toBeGreaterThan(0)
      if (p.mark !== null) expect(p.mark).toMatch(/^[a-z0-9-]+$/)
    }
  })

  it("shares a nameserver suffix only where registrars break the tie", () => {
    const bySuffix = new Map<string, typeof DNS_PROVIDERS>()
    for (const p of DNS_PROVIDERS)
      for (const s of p.nameservers)
        bySuffix.set(s, [...(bySuffix.get(s) ?? []), p])
    for (const [, sharing] of bySuffix) {
      if (sharing.length < 2) continue
      // One may be the default; every other names its registrars.
      expect(
        sharing.filter((p) => p.registrars.length === 0).length
      ).toBeLessThanOrEqual(1)
    }
    expect(bySuffix.get(".googledomains.com")?.map((p) => p.id)).toEqual([
      "squarespace",
      "google-cloud-dns",
    ])
  })

  it("links Cloudflare to the domain's own DNS page", () => {
    expect(dnsProvider("cloudflare")?.settingsUrl("bnwise.tech")).toBe(
      "https://dash.cloudflare.com/?to=/:account/bnwise.tech/dns/records"
    )
  })

  it("links GoDaddy, Namecheap, Squarespace and IONOS to the domain's DNS page", () => {
    const link = (id: string) => dnsProvider(id)?.settingsUrl("bnwise.tech")
    expect(link("godaddy")).toBe(
      "https://dcc.godaddy.com/control/dnsmanagement?domainName=bnwise.tech"
    )
    expect(link("namecheap")).toBe(
      "https://ap.www.namecheap.com/domains/domaincontrolpanel/bnwise.tech/advancedns"
    )
    expect(link("squarespace")).toBe(
      "https://account.squarespace.com/domains/managed/bnwise.tech/dns/dns-settings"
    )
    expect(link("ionos")).toBe(
      "https://my.ionos.co.uk/domain-dns-settings/bnwise.tech"
    )
  })

  it.each([
    ["hostinger", "https://hpanel.hostinger.com/domain/bnwise.tech/dns"],
    ["porkbun", "https://porkbun.com/account/dns/bnwise.tech"],
    [
      "namesilo",
      "https://www.namesilo.com/account_domain_manage_dns.php?domain=bnwise.tech",
    ],
    [
      "spaceship",
      "https://www.spaceship.com/application/advanced-dns-application/manage/bnwise.tech/",
    ],
    [
      "digitalocean",
      "https://cloud.digitalocean.com/networking/domains/bnwise.tech",
    ],
    ["ovh", "https://manager.eu.ovhcloud.com/#/web/domain/bnwise.tech/zone"],
    ["name-com", "https://www.name.com/account/domain/details/bnwise.tech#dns"],
    ["hover", "https://www.hover.com/control_panel/domain/bnwise.tech/dns"],
  ])("links %s to the domain's own DNS page", (id, link) => {
    expect(dnsProvider(id)?.settingsUrl("bnwise.tech")).toBe(link)
  })

  it("reads a registrar as RDAP spells it", () => {
    expect(
      registrarIn("Squarespace Domains II LLC", ["Squarespace Domains"])
    ).toBe(true)
    expect(registrarIn("Google LLC", ["Squarespace Domains"])).toBe(false)
  })
})
