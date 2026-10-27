import { expect, it } from "vitest"
import { keyPair } from "../../../infra/domain-connect/keygen.ts"
import { applyUrl } from "../src/domain-connect.ts"

/** The public key as a provider reads it: the TXT pieces in `p` order, joined. */
async function publicKeyFrom(txt: string[]) {
  const der = txt
    // Split at the first "=" only: base64 ends in "=" padding.
    .map((value) =>
      Object.fromEntries(value.split(",").map((t) => t.split(/=(.*)/s)))
    )
    .sort((a, b) => Number(a.p) - Number(b.p))
    .map((tags) => tags.d)
    .join("")
  return crypto.subtle.importKey(
    "spki",
    Uint8Array.from(atob(der), (c) => c.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  )
}

it("signs an apply link the published TXT key verifies, with sig last", async () => {
  const { privateKey, txt } = keyPair()
  expect(txt.length).toBeGreaterThan(1)
  for (const value of txt) {
    expect(value).toMatch(/^p=\d+,a=RS256,d=[A-Za-z0-9+/=]{1,200}$/)
  }
  const link = await applyUrl("dash.cloudflare.com/domainconnect", privateKey, {
    domain: "sparkleclean.co.uk",
    host: "www",
    redirect_uri:
      "https://staging.remeai.co.uk/api/domains/applied?name=sparkleclean.co.uk&c=7f9c",
  })
  const [path, query = ""] = link.split("?")
  expect(path).toBe(
    "https://dash.cloudflare.com/domainconnect/v2/domainTemplates/providers/remeai.co.uk/services/website/apply"
  )
  const params = [...new URLSearchParams(query).keys()]
  expect(params).toEqual(["domain", "host", "redirect_uri", "key", "sig"])
  const url = new URL(link)
  expect(url.searchParams.get("key")).toBe("_dck1")
  expect(url.searchParams.get("redirect_uri")).toBe(
    "https://staging.remeai.co.uk/api/domains/applied?name=sparkleclean.co.uk&c=7f9c"
  )

  // What the provider checks: the query before `key` and `sig`, as sent.
  const signed = query.slice(0, query.indexOf("&key="))
  const sig = Uint8Array.from(atob(url.searchParams.get("sig") ?? ""), (c) =>
    c.charCodeAt(0)
  )
  const key = await publicKeyFrom(txt)
  const verify = (text: string) =>
    crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      sig,
      new TextEncoder().encode(text)
    )
  expect(await verify(signed)).toBe(true)
  expect(await verify(signed.replace("host=www", "host=shop"))).toBe(false)
})
