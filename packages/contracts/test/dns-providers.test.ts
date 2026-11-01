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

  it("reads a registrar as RDAP spells it", () => {
    expect(
      registrarIn("Squarespace Domains II LLC", ["Squarespace Domains"])
    ).toBe(true)
    expect(registrarIn("Google LLC", ["Squarespace Domains"])).toBe(false)
  })
})
