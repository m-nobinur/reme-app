// Sends Cloudflare's custom hostname alert (SSL for SaaS: validation, issuance,
// deployment, renewal) to one environment's api, so a connecting domain goes
// live when its certificate does. Usage:
//   CF_WEBHOOK_SECRET=... node scripts/domain-alert.mjs staging https://<api host>/webhooks/cloudflare
// Needs CLOUDFLARE_API_TOKEN (Account > Notifications > Edit) and
// CLOUDFLARE_ACCOUNT_ID, from the environment or .env.local. Safe to run
// again: the destination and the policy are found by name and updated, never
// added twice. The secret is never printed. Cloudflare returns none, so the
// destination is always written, and that line reads `set`.
//
// The alert is account-wide: staging and production each get their own
// destination and policy, and each api ignores a hostname it does not hold.
import { bad, loadLocalEnv, ok, repoRoot } from "./lib.mjs"

process.chdir(repoRoot)
loadLocalEnv()

const [environment, url] = process.argv.slice(2)
const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CF_WEBHOOK_SECRET } =
  process.env
if (
  !environment ||
  !url?.startsWith("https://") ||
  !CLOUDFLARE_API_TOKEN ||
  !CLOUDFLARE_ACCOUNT_ID ||
  !CF_WEBHOOK_SECRET
) {
  bad(
    "usage: CF_WEBHOOK_SECRET=... node scripts/domain-alert.mjs <environment> <https webhook url>, with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID set"
  )
  process.exit(1)
}

const api = async (method, path, body) => {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/alerting/v3/${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: body && JSON.stringify(body),
    }
  )
  const json = await response.json().catch(() => ({}))
  if (!response.ok || json.success === false) {
    bad(
      `${method} ${path}: ${response.status} ${(json.errors ?? []).map((e) => e.message).join("; ")}`
    )
    process.exit(1)
  }
  return json.result
}

/** Updates the item called `body.name` or adds it; returns its id. */
async function upsert(path, body) {
  const existing = (await api("GET", path)).find((i) => i.name === body.name)
  const result = existing
    ? await api("PUT", `${path}/${existing.id}`, body)
    : await api("POST", path, body)
  return { id: existing?.id ?? result.id, action: existing ? "set" : "added" }
}

const prefix = `reme ${environment} custom hostname`
const destination = await upsert("destinations/webhooks", {
  name: `${prefix} webhook`,
  url,
  secret: CF_WEBHOOK_SECRET,
})
ok(`${destination.action.padEnd(9)}  webhook destination ${prefix} webhook`)

const policy = await upsert("policies", {
  name: `${prefix} alert`,
  alert_type: "custom_ssl_certificate_event_type",
  enabled: true,
  mechanisms: { webhooks: [{ id: destination.id }] },
})
ok(`${policy.action.padEnd(9)}  notification policy ${prefix} alert`)
