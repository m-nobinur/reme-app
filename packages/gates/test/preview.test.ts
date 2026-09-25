import { describe, expect, it } from "vitest"
import {
  contentType,
  previewHeaders,
  resolvePreviewPath,
  signPreview,
  verifyPreview,
} from "../src/preview.ts"

const KEY = "preview-key-for-this-suite-only"
const ORG = "10000001-0000-4000-8000-000000000001"
const OTHER = "10000001-0000-4000-8000-000000000002"
const REV = "10000001-0000-4000-8000-000000000003"
const HOST = "preview-v3-brightclean-stg.remeai.co.uk"
const NOW = Date.parse("2026-09-15T12:00:00Z")
const claim = {
  org_id: ORG,
  site_id: ORG,
  revision_id: REV,
  host: HOST,
  scope: "site" as const,
  exp: NOW / 1000 + 3600,
}

describe("the preview token", () => {
  it("round-trips a claim signed with the key", async () => {
    const token = await signPreview(claim, KEY)
    expect(await verifyPreview(token, KEY, NOW)).toEqual(claim)
  })

  it("refuses another key, a changed claim, an expired claim and junk", async () => {
    const token = await signPreview(claim, KEY)
    expect(await verifyPreview(token, "another-key", NOW)).toBeNull()
    const [, mac] = token.split(".")
    const forged = `${btoa(JSON.stringify({ ...claim, org_id: OTHER })).replace(/=+$/, "")}.${mac}`
    expect(await verifyPreview(forged, KEY, NOW)).toBeNull()
    expect(await verifyPreview(token, KEY, NOW + 2 * 3600 * 1000)).toBeNull()
    // Exactly `exp` is already expired.
    expect(await verifyPreview(token, KEY, claim.exp * 1000)).toBeNull()
    expect(await verifyPreview(token, KEY, claim.exp * 1000 - 1)).toEqual(claim)
    for (const junk of [undefined, "", "a", "a.b.c", "!!.!!"]) {
      expect(await verifyPreview(junk, KEY, NOW)).toBeNull()
    }
    expect(await verifyPreview(token, "", NOW)).toBeNull()
  })

  it("refuses to sign or verify a claim the contract refuses", async () => {
    const { host: _host, ...hostless } = claim
    await expect(
      signPreview(hostless as unknown as typeof claim, KEY)
    ).rejects.toThrow()
    // A body that was signed by a key holder but does not parse is no claim.
    const { site_id: _site, ...siteless } = claim
    const body = btoa(JSON.stringify(siteless)).replace(/=+$/, "")
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(KEY),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    )
    const mac = btoa(
      String.fromCharCode(
        ...new Uint8Array(
          await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
        )
      )
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    expect(await verifyPreview(`${body}.${mac}`, KEY, NOW)).toBeNull()
  })
})

describe("preview paths", () => {
  const files = {
    "index.html": "a".repeat(64),
    "contact/index.html": "b".repeat(64),
    "_astro/index.C1.css": "c".repeat(64),
  }

  it("resolves the root, a directory and an asset through the manifest", () => {
    expect(resolvePreviewPath("/", files)).toEqual({
      key: "dist/index.html",
      file: "index.html",
    })
    expect(resolvePreviewPath("/contact/", files)?.key).toBe(
      "dist/contact/index.html"
    )
    expect(resolvePreviewPath("/contact", files)?.key).toBe(
      "dist/contact/index.html"
    )
    expect(resolvePreviewPath("/_astro/index.C1.css", files)?.key).toBe(
      "dist/_astro/index.C1.css"
    )
  })

  it("serves the three screenshots by name and nothing else from the bucket", () => {
    expect(resolvePreviewPath("/screenshots/home-390.png", files)?.key).toBe(
      "screenshots/home-390.png"
    )
    for (const path of [
      "/source.tar.zst",
      "/manifest.json",
      "/screenshots/other.png",
      "/../manifest.json",
      "/%2e%2e/manifest.json",
      "/missing/",
      "/constructor",
      "/%E0%A4%A",
    ]) {
      expect(resolvePreviewPath(path, files)).toBeNull()
    }
  })

  it("types what it serves, and the manifest never sets the type or the caching", () => {
    expect(contentType("_astro/index.C1.css")).toBe("text/css; charset=utf-8")
    expect(contentType("source.tar.zst")).toBe("application/octet-stream")
    const headers = previewHeaders(
      {
        "x-frame-options": "DENY",
        "cache-control": "public, max-age=999",
        "content-type": "text/plain",
      },
      "index.html"
    )
    expect(Object.fromEntries(headers)).toEqual({
      "cache-control": "private, no-store",
      "content-type": "text/html; charset=utf-8",
      "x-frame-options": "DENY",
    })
    expect(
      previewHeaders({}, "_astro/a.css", "public, max-age=1").get(
        "cache-control"
      )
    ).toBe("public, max-age=1")
  })
})
