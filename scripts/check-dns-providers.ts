// Before a release: fetches every DNS provider link in the registry and
// resolves one known domain per provider, so a dead link or a moved
// nameserver shows before an owner meets it. Run once by hand:
//   node scripts/check-dns-providers.ts
import { resolveNs } from "node:dns/promises"
import { DNS_PROVIDERS } from "../packages/contracts/src/dns-providers.ts"

/** A real domain on each provider's nameservers, seen 2026-10-31. */
const KNOWN: Record<string, string> = {
  cloudflare: "namesilo.com",
  godaddy: "",
  "123-reg": "",
  ionos: "ionos.co.uk",
  namecheap: "namecheap.com",
  squarespace: "squarespace.com",
  "google-cloud-dns": "kubernetes.io",
  wix: "slanecon.com",
  fasthosts: "fasthosts.co.uk",
  gandi: "gandi.net",
  porkbun: "",
  hostinger: "hostinger.com",
  vercel: "nextjs.org",
  "route-53": "porkbun.com",
  hetzner: "sebhosting.de",
  ovh: "ovhcloud.com",
  namesilo: "dnsowl.com",
  spaceship: "authorbiz.com",
  "wordpress-com": "wordpress.com",
  siteground: "siteground.com",
  dreamhost: "dreamhost.com",
  "one-com": "matmech.com",
  dynadot: "dyna-ns.net",
  krystal: "purplepatcharts.org",
  "34sp": "34sp.com",
  digitalocean: "mistermaths.co.uk",
  bluehost: "cmapakistan.org",
  hostgator: "leduvs.com",
  "name-com": "goprogecko.com",
  hover: "harmonise.net",
  "heart-internet": "alienslegacy.com",
  lcn: "lcn.com",
  "names-co-uk": "names.co.uk",
}

// Bot checks answer a script 401, 403 or 429; the page is there behind them.
const reachable = (status: number) =>
  status < 400 || status === 401 || status === 403 || status === 429

async function linkStatus(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 reme-link-check" },
      signal: AbortSignal.timeout(15_000),
    })
    await response.body?.cancel()
    return reachable(response.status)
      ? "ok"
      : `${response.status} ${response.url}`
  } catch (error) {
    return (error as Error).message
  }
}

const failed: string[] = []
for (const provider of DNS_PROVIDERS) {
  const domain = KNOWN[provider.id]
  const [settings, help, ns] = await Promise.all([
    linkStatus(provider.settingsUrl(domain || "example.com")),
    linkStatus(provider.helpUrl),
    domain
      ? resolveNs(domain).then(
          (hosts) =>
            hosts.some((h) =>
              provider.nameservers.some((s) => h.toLowerCase().endsWith(s))
            )
              ? "ok"
              : `not on ${provider.name}: ${hosts.join(" ")}`,
          (error: Error) => error.message
        )
      : Promise.resolve("no known domain"),
  ])
  const bad = [settings, help, ns].some(
    (s) => s !== "ok" && s !== "no known domain"
  )
  if (bad) failed.push(provider.id)
  console.log(
    `${bad ? "FAIL" : "ok  "} ${provider.id.padEnd(18)} settings ${settings} · help ${help} · ns ${ns}`
  )
}
process.exitCode = failed.length > 0 ? 1 : 0
