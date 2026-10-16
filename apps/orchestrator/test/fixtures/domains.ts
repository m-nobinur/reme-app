/**
 * Recorded DNS-over-HTTPS and Domain Connect answers, captured read-only on
 * 2026-10-16 from cloudflare-dns.com and each provider's public settings
 * endpoint. The answers are verbatim; only the domain names are swapped for
 * the plan's example names so no real business is in the repo.
 */

type DohBody = {
  Status: number
  Answer?: Array<{ name: string; type: number; TTL: number; data: string }>
  Authority?: Array<{ name: string; type: number; TTL: number; data: string }>
}

/** Keyed `"{name} {TYPE}"`; a query not listed answers NOERROR with nothing. */
export const DOH: Record<string, DohBody> = {
  // GoDaddy: the `_domainconnect` label is a CNAME into domaincontrol.com.
  "sparklecleanbristol.co.uk NS": {
    Status: 0,
    Answer: [
      {
        name: "sparklecleanbristol.co.uk",
        type: 2,
        TTL: 3600,
        data: "ns47.domaincontrol.com.",
      },
      {
        name: "sparklecleanbristol.co.uk",
        type: 2,
        TTL: 3600,
        data: "ns48.domaincontrol.com.",
      },
    ],
  },
  "_domainconnect.sparklecleanbristol.co.uk TXT": {
    Status: 0,
    Answer: [
      {
        name: "_domainconnect.sparklecleanbristol.co.uk",
        type: 5,
        TTL: 3594,
        data: "_domainconnect.gd.domaincontrol.com.",
      },
      {
        name: "_domainconnect.gd.domaincontrol.com",
        type: 16,
        TTL: 3594,
        data: '"domainconnect.api.godaddy.com"',
      },
    ],
  },
  // 123 Reg, a GoDaddy brand on the same nameservers, answers via secureserver.net.
  "sparkleclean123.co.uk NS": {
    Status: 0,
    Answer: [
      {
        name: "sparkleclean123.co.uk",
        type: 2,
        TTL: 3600,
        data: "ns53.domaincontrol.com.",
      },
      {
        name: "sparkleclean123.co.uk",
        type: 2,
        TTL: 3600,
        data: "ns54.domaincontrol.com.",
      },
    ],
  },
  "_domainconnect.sparkleclean123.co.uk TXT": {
    Status: 0,
    Answer: [
      {
        name: "_domainconnect.sparkleclean123.co.uk",
        type: 5,
        TTL: 3596,
        data: "_domainconnect.ss.domaincontrol.com.",
      },
      {
        name: "_domainconnect.ss.domaincontrol.com",
        type: 16,
        TTL: 3596,
        data: '"domainconnect.api.secureserver.net"',
      },
    ],
  },
  // Cloudflare: the TXT carries a path; the settings answer has no urlControlPanel.
  "sparkleclean.co.uk NS": {
    Status: 0,
    Answer: [
      {
        name: "sparkleclean.co.uk",
        type: 2,
        TTL: 86400,
        data: "etienne.ns.cloudflare.com.",
      },
      {
        name: "sparkleclean.co.uk",
        type: 2,
        TTL: 86400,
        data: "grace.ns.cloudflare.com.",
      },
    ],
  },
  "_domainconnect.sparkleclean.co.uk TXT": {
    Status: 0,
    Answer: [
      {
        name: "_domainconnect.sparkleclean.co.uk",
        type: 16,
        TTL: 3600,
        data: '"api.cloudflare.com/client/v4/dns/domainconnect"',
      },
    ],
  },
  // A record that is not Domain Connect at all: a wildcard TXT answering the label.
  "_domainconnect.wildcard.co.uk TXT": {
    Status: 0,
    Answer: [
      {
        name: "_domainconnect.wildcard.co.uk",
        type: 16,
        TTL: 3593,
        data: '"v=DMARC1; p=reject; adkim=s; aspf=s;"',
      },
      {
        name: "_domainconnect.wildcard.co.uk",
        type: 16,
        TTL: 3593,
        data: '"v=spf1 -all"',
      },
    ],
  },
  "wildcard.co.uk NS": {
    Status: 0,
    Answer: [
      {
        name: "wildcard.co.uk",
        type: 2,
        TTL: 3600,
        data: "ns53.domaincontrol.com.",
      },
    ],
  },
  // The SOA for a host comes back in Authority, naming the zone.
  "www.sparklecleanbristol.co.uk SOA": {
    Status: 0,
    Authority: [
      {
        name: "sparklecleanbristol.co.uk",
        type: 6,
        TTL: 600,
        data: "ns47.domaincontrol.com. dns.jomax.net. 2024030600 28800 7200 604800 600",
      },
    ],
  },
  "sparklecleanbristol.co.uk MX": {
    Status: 0,
    Answer: [
      {
        name: "sparklecleanbristol.co.uk",
        type: 15,
        TTL: 8600,
        data: "10 mail.neomailsrvr.com.",
      },
    ],
  },
  "sparklecleanbristol.co.uk A": {
    Status: 0,
    Answer: [
      {
        name: "sparklecleanbristol.co.uk",
        type: 1,
        TTL: 600,
        data: "192.0.2.10",
      },
    ],
  },
  // The planted old record: www still has its A, no CNAME.
  "www.sparklecleanbristol.co.uk A": {
    Status: 0,
    Answer: [
      {
        name: "www.sparklecleanbristol.co.uk",
        type: 1,
        TTL: 8600,
        data: "192.0.2.10",
      },
    ],
  },
  "sparklecleanbristol.co.uk CAA": {
    Status: 0,
    Answer: [
      {
        name: "sparklecleanbristol.co.uk",
        type: 257,
        TTL: 3600,
        data: '0 issue "digicert.com"',
      },
      {
        name: "sparklecleanbristol.co.uk",
        type: 257,
        TTL: 3600,
        data: '0 iodef "mailto:it@sparklecleanbristol.co.uk"',
      },
    ],
  },
  "domains.remeai.co.uk A": {
    Status: 0,
    Answer: [
      { name: "domains.remeai.co.uk", type: 1, TTL: 300, data: "104.21.0.10" },
      { name: "domains.remeai.co.uk", type: 1, TTL: 300, data: "172.67.0.10" },
    ],
  },
  "domains.remeai.co.uk AAAA": {
    Status: 0,
    Answer: [
      {
        name: "domains.remeai.co.uk",
        type: 28,
        TTL: 300,
        data: "2606:4700:3030::10",
      },
    ],
  },
  "nowhere-at-all.co.uk SOA": {
    Status: 3,
    Authority: [
      {
        name: "co.uk",
        type: 6,
        TTL: 10800,
        data: "dns1.nic.uk. hostmaster.nominet.org.uk. 1792139228 900 300 2419200 10800",
      },
    ],
  },
}

/** Provider settings answers, keyed by the URL discovery fetches. */
export const SETTINGS: Record<string, unknown> = {
  "https://domainconnect.api.godaddy.com/v2/sparklecleanbristol.co.uk/settings":
    {
      nameServers: ["ns47.domaincontrol.com", "ns48.domaincontrol.com"],
      providerDisplayName: "GoDaddy",
      providerId: "godaddy.com",
      providerName: "GoDaddy",
      urlAPI: "https://domainconnect.api.godaddy.com",
      urlAsyncUX: "https://dcc.godaddy.com/manage",
      urlControlPanel: "https://dcc.godaddy.com/manage/dns",
      urlSyncUX: "https://dcc.godaddy.com/manage",
    },
  "https://domainconnect.api.secureserver.net/v2/sparkleclean123.co.uk/settings":
    {
      nameServers: ["ns53.domaincontrol.com", "ns54.domaincontrol.com"],
      providerDisplayName: "123 Reg",
      providerId: "secureserver.net",
      providerName: "Secure Server",
      urlAPI: "https://domainconnect.api.secureserver.net",
      urlAsyncUX: "https://dcc.secureserver.net/manage",
      urlControlPanel: "https://dcc.secureserver.net/manage/dns",
      urlSyncUX: "https://dcc.secureserver.net/manage",
    },
  "https://api.cloudflare.com/client/v4/dns/domainconnect/v2/sparkleclean.co.uk/settings":
    {
      providerId: "cloudflare.com",
      providerName: "cloudflare",
      providerDisplayName: "Cloudflare",
      urlSyncUX: "https://dash.cloudflare.com/domainconnect",
      urlAPI: "https://api.cloudflare.com/client/v4/dns/domainconnect",
    },
}
