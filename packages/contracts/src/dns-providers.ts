// The DNS providers Reme recognises, read by the orchestrator (recognition,
// settings links) and the UI (mark, card labels). Links come only from here,
// never from a domain's own DNS. Each nameserver suffix was seen on a real
// domain with a live NS lookup on 2026-10-31; a provider whose suffix could
// not be confirmed is left out rather than guessed.

/** How the bare domain can reach the site: an ALIAS (or flattened CNAME) to us, or the provider's forward to `www`. */
export type ApexSupport = "alias" | "forward"

export type DnsProviderEntry = {
  id: string
  /** The name the owner knows. */
  name: string
  /** Nameserver host suffixes; the longest match wins. */
  nameservers: readonly string[]
  /** RDAP registrar names that break a tie between entries sharing a suffix. */
  registrars: readonly string[]
  /**
   * The provider's DNS page. A landing page unless the per-domain link was
   * tested signed in, recorded beside it with the date.
   */
  settingsUrl: (domain: string) => string
  /** The provider's own article on adding a CNAME. */
  helpUrl: string
  /** What the provider's screen calls a record's name and value, when not Name and Value. */
  labels?: { name: string; value: string }
  apex: ApexSupport
  /** One screen-specific line, when the provider needs one. */
  note?: string
  /** The vendored mark's id, or null where no library has the brand. */
  mark: string | null
}

export const DEFAULT_LABELS = { name: "Name", value: "Value" } as const

const page = (url: string) => () => url

/** Route 53's nameservers sit under awsdns-00 to awsdns-63, on four endings. */
const AWSDNS = ["com", "net", "org", "co.uk"].flatMap((tld) =>
  Array.from(
    { length: 64 },
    (_, n) => `.awsdns-${String(n).padStart(2, "0")}.${tld}`
  )
)

export const DNS_PROVIDERS: readonly DnsProviderEntry[] = [
  {
    id: "cloudflare",
    name: "Cloudflare",
    nameservers: [".ns.cloudflare.com"],
    registrars: [],
    // Per-domain: `:account` makes the dashboard pick the signed-in account.
    settingsUrl: (domain) =>
      `https://dash.cloudflare.com/?to=/:account/${domain}/dns/records`,
    helpUrl:
      "https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/",
    labels: { name: "Name", value: "Target" },
    apex: "alias",
    // Cloudflare for SaaS advises customers not to proxy the provider's hostname.
    note: "Set Proxy status to DNS only. For @, choose CNAME and Cloudflare flattens it.",
    mark: "cloudflare",
  },
  {
    id: "godaddy",
    name: "GoDaddy",
    nameservers: [".domaincontrol.com"],
    registrars: [],
    // Per-domain; signed out it keeps the path through login (checked 2026-11-01).
    settingsUrl: (domain) =>
      `https://dcc.godaddy.com/control/dnsmanagement?domainName=${domain}`,
    helpUrl: "https://www.godaddy.com/help/add-a-cname-record-19236",
    apex: "forward",
    mark: "godaddy",
  },
  {
    id: "123-reg",
    name: "123-reg",
    nameservers: [".123-reg.co.uk"],
    registrars: [],
    settingsUrl: page("https://www.123-reg.co.uk/secure/"),
    helpUrl: "https://www.123-reg.co.uk/support/domains/",
    apex: "forward",
    mark: null,
  },
  {
    id: "ionos",
    name: "IONOS",
    nameservers: [".ui-dns.com", ".ui-dns.org", ".ui-dns.biz", ".ui-dns.de"],
    registrars: [],
    // Per-domain; signed out it keeps the path through login (checked 2026-11-01).
    // shortcut: always the UK account host, since nameservers do not show the market; use the owner's country when non-UK owners arrive.
    settingsUrl: (domain) =>
      `https://my.ionos.co.uk/domain-dns-settings/${domain}`,
    helpUrl:
      "https://www.ionos.co.uk/help/domains/configuring-cname-records-for-subdomains/configuring-a-cname-record-for-a-subdomain/",
    labels: { name: "Host name", value: "Points to" },
    apex: "forward",
    mark: "ionos",
  },
  {
    id: "namecheap",
    name: "Namecheap",
    nameservers: [".registrar-servers.com"],
    registrars: [],
    // Per-domain; signed out it keeps the path through login (checked 2026-11-01).
    settingsUrl: (domain) =>
      `https://ap.www.namecheap.com/domains/domaincontrolpanel/${domain}/advancedns`,
    helpUrl:
      "https://www.namecheap.com/support/knowledgebase/article.aspx/9646/2237/how-to-create-a-cname-record-for-your-domain/",
    labels: { name: "Host", value: "Value" },
    apex: "alias",
    note: "Open Manage, then Advanced DNS.",
    mark: "namecheap",
  },
  {
    id: "squarespace",
    name: "Squarespace",
    nameservers: [".squarespacedns.com", ".googledomains.com"],
    registrars: ["Squarespace Domains"],
    // Per-domain, also for domains moved from Google Domains.
    settingsUrl: (domain) =>
      `https://account.squarespace.com/domains/managed/${domain}/dns/dns-settings`,
    helpUrl:
      "https://support.squarespace.com/hc/en-us/articles/360002101888-Adding-custom-DNS-records-to-your-Squarespace-managed-domain",
    labels: { name: "Host", value: "Data" },
    apex: "forward",
    mark: "squarespace",
  },
  {
    // Shares Squarespace's nameservers; it is the one without a registrar.
    id: "google-cloud-dns",
    name: "Google Cloud DNS",
    nameservers: [".googledomains.com"],
    registrars: [],
    settingsUrl: page(
      "https://console.cloud.google.com/net-services/dns/zones"
    ),
    helpUrl: "https://cloud.google.com/dns/docs/records",
    labels: { name: "DNS name", value: "Canonical name" },
    apex: "forward",
    mark: "google-cloud",
  },
  {
    id: "wix",
    name: "Wix",
    nameservers: [".wixdns.net", ".wix.com"],
    registrars: [],
    settingsUrl: page("https://manage.wix.com/account/domains"),
    helpUrl:
      "https://support.wix.com/en/article/adding-or-updating-cname-records-in-your-wix-account",
    labels: { name: "Host name", value: "Value" },
    apex: "forward",
    mark: "wix",
  },
  {
    // Fasthosts runs on IONOS's nameservers under its own `ns-fh` hosts.
    id: "fasthosts",
    name: "Fasthosts",
    nameservers: [
      ".livedns.co.uk",
      "ns-fh.ui-dns.com",
      "ns-fh.ui-dns.org",
      "ns-fh.ui-dns.biz",
      "ns-fh.ui-dns.co.uk",
    ],
    registrars: [],
    settingsUrl: page("https://admin.fasthosts.co.uk/"),
    helpUrl: "https://help.fasthosts.co.uk/",
    apex: "forward",
    mark: null,
  },
  {
    id: "gandi",
    name: "Gandi",
    nameservers: [".gandi.net"],
    registrars: [],
    settingsUrl: page("https://admin.gandi.net/domain"),
    helpUrl:
      "https://docs.gandi.net/en/domain_names/common_operations/dns_records.html",
    apex: "alias",
    mark: "gandi",
  },
  {
    id: "porkbun",
    name: "Porkbun",
    nameservers: [".ns.porkbun.com"],
    registrars: [],
    settingsUrl: page("https://porkbun.com/account/domainsSpeedy"),
    helpUrl:
      "https://kb.porkbun.com/article/54-how-to-add-dns-records-on-porkbun",
    labels: { name: "Host", value: "Answer" },
    apex: "alias",
    mark: "porkbun",
  },
  {
    id: "hostinger",
    name: "Hostinger",
    nameservers: [".dns-parking.com", ".hostinger.com"],
    registrars: [],
    settingsUrl: page("https://hpanel.hostinger.com/domains"),
    helpUrl:
      "https://support.hostinger.com/en/articles/1583249-how-to-manage-dns-records-at-hostinger",
    labels: { name: "Name", value: "Points to" },
    apex: "forward",
    mark: "hostinger",
  },
  {
    id: "vercel",
    name: "Vercel",
    nameservers: [".vercel-dns.com"],
    registrars: [],
    settingsUrl: page("https://vercel.com/dashboard/domains"),
    helpUrl: "https://vercel.com/docs/domains/managing-dns-records",
    apex: "alias",
    mark: "vercel",
  },
  {
    id: "route-53",
    name: "Amazon Route 53",
    nameservers: AWSDNS,
    registrars: [],
    settingsUrl: page("https://console.aws.amazon.com/route53/v2/hostedzones"),
    helpUrl:
      "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-creating.html",
    labels: { name: "Record name", value: "Value" },
    apex: "forward",
    mark: "aws-route53",
  },
  {
    id: "hetzner",
    name: "Hetzner",
    nameservers: [
      ".ns.hetzner.com",
      ".ns.hetzner.de",
      ".your-server.de",
      ".first-ns.de",
      ".second-ns.de",
      ".second-ns.com",
    ],
    registrars: [],
    settingsUrl: page("https://dns.hetzner.com/"),
    helpUrl: "https://docs.hetzner.com/dns-console/dns/general/dns-overview/",
    apex: "forward",
    mark: "hetzner",
  },
  {
    id: "ovh",
    name: "OVHcloud",
    nameservers: [".ovh.net", ".anycast.me"],
    registrars: [],
    settingsUrl: page("https://manager.eu.ovhcloud.com/"),
    helpUrl:
      "https://help.ovhcloud.com/csm/en-gb-dns-edit-dns-zone?id=kb_article_view&sysparm_article=KB0051684",
    labels: { name: "Sub-domain", value: "Target" },
    apex: "forward",
    mark: "ovh",
  },
  {
    id: "namesilo",
    name: "NameSilo",
    nameservers: [".dnsowl.com"],
    registrars: [],
    settingsUrl: page("https://www.namesilo.com/account_domains.php"),
    helpUrl:
      "https://www.namesilo.com/support/v2/articles/domain-manager/dns-manager",
    labels: { name: "Hostname", value: "Target hostname" },
    apex: "forward",
    mark: "namesilo",
  },
  {
    id: "spaceship",
    name: "Spaceship",
    nameservers: [".spaceship.net", ".spaceship.com"],
    registrars: [],
    settingsUrl: page(
      "https://www.spaceship.com/application/domain-list-application/"
    ),
    helpUrl: "https://www.spaceship.com/knowledgebase/",
    labels: { name: "Host", value: "Value" },
    apex: "forward",
    mark: "spaceship",
  },
  {
    id: "wordpress-com",
    name: "WordPress.com",
    nameservers: [".wordpress.com"],
    registrars: [],
    settingsUrl: page("https://wordpress.com/domains/manage"),
    helpUrl: "https://wordpress.com/support/domains/custom-dns/",
    apex: "forward",
    mark: "wordpress",
  },
  {
    id: "siteground",
    name: "SiteGround",
    nameservers: [".siteground.net", ".siteground.com", ".sgvps.net"],
    registrars: [],
    settingsUrl: page("https://my.siteground.com/"),
    helpUrl: "https://www.siteground.com/kb/",
    labels: { name: "Name", value: "Resolves to" },
    apex: "forward",
    mark: null,
  },
  {
    id: "dreamhost",
    name: "DreamHost",
    nameservers: [".dreamhost.com"],
    registrars: [],
    settingsUrl: page("https://panel.dreamhost.com/"),
    helpUrl:
      "https://help.dreamhost.com/hc/en-us/articles/360035516812-Adding-custom-DNS-records",
    labels: { name: "Host", value: "Value" },
    apex: "forward",
    mark: "dreamhost",
  },
  {
    id: "one-com",
    name: "one.com",
    nameservers: [".one.com", ".g1-dns.com", ".g1-dns.one"],
    registrars: [],
    settingsUrl: page("https://www.one.com/admin/"),
    helpUrl: "https://help.one.com/hc/en-us",
    apex: "forward",
    mark: null,
  },
  {
    id: "dynadot",
    name: "Dynadot",
    nameservers: [".dyna-ns.net"],
    registrars: [],
    settingsUrl: page("https://www.dynadot.com/account/domain/name/list.html"),
    helpUrl: "https://www.dynadot.com/help",
    apex: "forward",
    mark: null,
  },
  {
    id: "krystal",
    name: "Krystal",
    nameservers: [".krystal.uk", ".katapult.io"],
    registrars: [],
    settingsUrl: page("https://krystal.io/"),
    helpUrl: "https://help.krystal.io/",
    apex: "forward",
    mark: null,
  },
  {
    id: "digitalocean",
    name: "DigitalOcean",
    nameservers: [".digitalocean.com"],
    registrars: [],
    settingsUrl: page("https://cloud.digitalocean.com/networking/domains"),
    helpUrl:
      "https://docs.digitalocean.com/products/networking/dns/how-to/manage-records/",
    labels: { name: "Hostname", value: "Is an alias of" },
    apex: "forward",
    mark: "digitalocean",
  },
  {
    id: "bluehost",
    name: "Bluehost",
    nameservers: [".bluehost.com"],
    registrars: [],
    settingsUrl: page("https://my.bluehost.com/"),
    helpUrl: "https://www.bluehost.com/help",
    apex: "forward",
    mark: null,
  },
  {
    id: "hostgator",
    name: "HostGator",
    nameservers: [".hostgator.com"],
    registrars: [],
    settingsUrl: page("https://portal.hostgator.com/"),
    helpUrl: "https://www.hostgator.com/help",
    apex: "forward",
    mark: "hostgator",
  },
  {
    id: "name-com",
    name: "Name.com",
    nameservers: [".name.com"],
    registrars: [],
    settingsUrl: page("https://www.name.com/account/domain"),
    helpUrl: "https://www.name.com/support",
    apex: "forward",
    mark: null,
  },
  {
    id: "hover",
    name: "Hover",
    nameservers: [".hover.com"],
    registrars: [],
    settingsUrl: page("https://www.hover.com/control_panel"),
    helpUrl: "https://help.hover.com/",
    apex: "forward",
    mark: null,
  },
  {
    id: "heart-internet",
    name: "Heart Internet",
    nameservers: [".mainnameserver.com"],
    registrars: [],
    settingsUrl: page("https://customer.heartinternet.uk/"),
    helpUrl: "https://www.heartinternet.uk/support/",
    apex: "forward",
    mark: null,
  },
  {
    id: "34sp",
    name: "34SP.com",
    nameservers: [".34sp.com"],
    registrars: [],
    settingsUrl: page("https://account.34sp.com/"),
    helpUrl: "https://www.34sp.com/kb",
    apex: "forward",
    mark: null,
  },
  {
    id: "lcn",
    name: "LCN",
    nameservers: [".lcn.com"],
    registrars: [],
    settingsUrl: page("https://www.lcn.com/"),
    helpUrl: "https://www.lcn.com/support/",
    apex: "forward",
    mark: null,
  },
  {
    id: "names-co-uk",
    name: "Names.co.uk",
    nameservers: [".phase8.net"],
    registrars: [],
    settingsUrl: page("https://admin.names.co.uk/"),
    helpUrl: "https://www.names.co.uk/support/",
    apex: "forward",
    mark: null,
  },
]

/**
 * Registrars resellers sit in front of. Never named as where to go: the
 * owner bought the domain from someone else.
 */
export const WHOLESALE_REGISTRARS = [
  "Tucows",
  "eNom",
  "OpenSRS",
  "Key-Systems",
  "CentralNic",
] as const

/** Lower-case letters and digits only, so "123 Reg" and "123-reg" agree. */
export const nameKey = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]/g, "")

/** Whether a registrar's name is one of `names`, as RDAP spells it ("Squarespace Domains II LLC"). */
export const registrarIn = (registrar: string, names: readonly string[]) =>
  names.some((n) => nameKey(registrar).startsWith(nameKey(n)))

export const dnsProvider = (id: string | undefined) =>
  DNS_PROVIDERS.find((p) => p.id === id)
