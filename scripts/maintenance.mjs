// Locks production behind the maintenance page and unlocks it again.
//   node scripts/maintenance.mjs status | on | off
// `on` moves preview.remeai.co.uk from reme-web-production to reme-maintenance
// (deploy that Worker first: pnpm --filter maintenance deploy). `off` moves it
// back. Only the hostname binding moves, so no web code is redeployed.
import { readFileSync } from "node:fs"

const HOST = "preview.remeai.co.uk"
const ZONE = "remeai.co.uk"
const WEB = "reme-web-production"
const MAINTENANCE = "reme-maintenance"

for (const line of readFileSync(
  new URL("../.env.local", import.meta.url),
  "utf8"
).split("\n")) {
  const m = line.match(/^(CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)=(.*)$/)
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "")
}
const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account } =
  process.env

async function api(method, path, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body && JSON.stringify(body),
  })
  const text = await res.text()
  const json = text ? JSON.parse(text) : { success: res.ok, result: null }
  if (!json.success)
    throw new Error(`${method} ${path}: ${JSON.stringify(json.errors)}`)
  return json.result
}

const zone = (await api("GET", `/zones?name=${ZONE}`))[0].id
const owners = async () => ({
  domain: (
    await api("GET", `/accounts/${account}/workers/domains?hostname=${HOST}`)
  )[0],
  route: (await api("GET", `/zones/${zone}/workers/routes`)).find(
    (r) => r.pattern === `${HOST}/*`
  ),
})

const mode = process.argv[2]
const before = await owners()
console.log(
  `${HOST}: domain -> ${before.domain?.service}, route -> ${before.route?.script}`
)

if (mode === "on" || mode === "off") {
  const to = mode === "on" ? MAINTENANCE : WEB
  const from = mode === "on" ? WEB : MAINTENANCE
  if (before.domain?.service === to && before.route?.script === to) {
    console.log("already there")
  } else {
    const free = (owner) => owner === undefined || owner === from
    if (!free(before.domain?.service) || !free(before.route?.script)) {
      throw new Error(
        `expected ${HOST} to belong to ${from}; refusing to move it`
      )
    }
    if (before.route) {
      await api("DELETE", `/zones/${zone}/workers/routes/${before.route.id}`)
    }
    if (before.domain) {
      await api(
        "DELETE",
        `/accounts/${account}/workers/domains/${before.domain.id}`
      )
    }
    await api("PUT", `/accounts/${account}/workers/domains`, {
      hostname: HOST,
      service: to,
      zone_id: zone,
      environment: "production",
    })
    await api("POST", `/zones/${zone}/workers/routes`, {
      pattern: `${HOST}/*`,
      script: to,
    })
    const after = await owners()
    console.log(
      `${HOST}: domain -> ${after.domain?.service}, route -> ${after.route?.script}`
    )
  }
}
