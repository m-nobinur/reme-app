import { describe, expect, it, vi } from "vitest"
import {
  contentType,
  previewHeaders,
  resolvePreviewPath,
  signPreview,
  verifyPreview,
} from "../src/preview.ts"
import { freshOrg, newAssignment } from "./fixture.ts"

const KEY = "preview-key-for-this-suite-only"
const ORG = "10000001-0000-4000-8000-000000000001"
const OTHER = "10000001-0000-4000-8000-000000000002"
const REV = "10000001-0000-4000-8000-000000000003"
const NOW = Date.parse("2026-09-15T12:00:00Z")
const claim = { org_id: ORG, revision_id: REV, exp: NOW / 1000 + 3600 }

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
    for (const junk of [undefined, "", "a", "a.b.c", "!!.!!"]) {
      expect(await verifyPreview(junk, KEY, NOW)).toBeNull()
    }
    expect(await verifyPreview(token, "", NOW)).toBeNull()
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

  it("types what it serves and adds no caching and nothing else", () => {
    expect(contentType("_astro/index.C1.css")).toBe("text/css; charset=utf-8")
    expect(contentType("source.tar.zst")).toBe("application/octet-stream")
    const headers = previewHeaders({ "x-frame-options": "DENY" }, "index.html")
    expect(Object.fromEntries(headers)).toEqual({
      "cache-control": "private, no-store",
      "content-type": "text/html; charset=utf-8",
      "x-frame-options": "DENY",
    })
  })
})

// The routes below reach neither a container nor an agent; both modules bind
// to Cloudflare at import time, so they are stood in for as in the app suite.
vi.mock("../src/sandbox.ts", () => ({
  probe: async () => {
    throw new Error("no container in this suite")
  },
  sandboxFor: () => ({ destroy: async () => undefined }),
}))
vi.mock("../src/agents/developer.ts", () => ({ Developer: {} }))

const { default: app } = await import("../src/app.ts")
const { siteRevisions, tenancy } = await import("@workspace/db")

const PREVIEW_HOST = "staging-preview.remeai.co.uk"
const CONSOLE = "https://staging-orchestrator.remeai.co.uk"
const PREVIEW = `https://${PREVIEW_HOST}`
const url = process.env.DATABASE_URL

const objects = new Map<string, string>()
const env = {
  ORCHESTRATOR_TOKEN: "test-token",
  PREVIEW_KEY: KEY,
  PREVIEW_HOST,
  HYPERDRIVE: { connectionString: url ?? "postgres://stub" },
  SITES: {
    get: async (key: string) => {
      const body = objects.get(key)
      return body === undefined
        ? null
        : {
            body,
            text: async () => body,
            json: async () => JSON.parse(body),
          }
    },
  },
} as unknown as Env

const cookieFor = (token: string) => ({ cookie: `reme_preview=${token}` })

describe("the preview host and the console host", () => {
  it("answers 404 for console routes on the preview host", async () => {
    for (const path of [
      "/assignments?org=brightclean",
      "/console",
      "/health",
    ]) {
      const res = await app.request(
        `${PREVIEW}${path}`,
        { headers: { authorization: "Bearer test-token" } },
        env
      )
      expect(res.status).toBe(404)
    }
  })

  it("answers 404 for preview paths on the console host", async () => {
    const token = await signPreview(claim, KEY)
    for (const path of [`/open?t=${token}`, "/", "/contact/"]) {
      const res = await app.request(`${CONSOLE}${path}`, {}, env)
      expect(res.status).toBe(404)
    }
  })

  it("opens a signed link as a cookie and redirects to the root, and refuses a bad one", async () => {
    const bad = await app.request(`${PREVIEW}/open?t=forged.token`, {}, env)
    expect(bad.status).toBe(404)
    expect(bad.headers.get("set-cookie")).toBeNull()

    const token = await signPreview(
      { ...claim, exp: Math.floor(Date.now() / 1000) + 3600 },
      KEY
    )
    const res = await app.request(`${PREVIEW}/open?t=${token}`, {}, env)
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/")
    const cookie = res.headers.get("set-cookie") ?? ""
    expect(cookie).toContain(`reme_preview=${token}`)
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) {
      expect(cookie).toContain(attr)
    }
  })

  it("serves nothing without a cookie", async () => {
    expect((await app.request(`${PREVIEW}/`, {}, env)).status).toBe(404)
  })
})

const live = describe.skipIf(!url)

live("a preview, against a real database", () => {
  const kit = tenancy(url ?? "postgres://unused")
  const soon = () => Math.floor(Date.now() / 1000) + 3600
  const HEADERS = {
    "content-security-policy": "default-src 'self'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-frame-options": "DENY",
  }

  async function revision(orgId: string) {
    const assignment = await newAssignment(kit, orgId)
    const id = crypto.randomUUID()
    const prefix = `sites/${orgId}/${id}/`
    await kit.withOrg({ orgId }, (db) =>
      db.insert(siteRevisions).values({
        id,
        orgId,
        siteId: orgId,
        assignmentId: assignment.assignmentId,
        version: 1,
        sourceKey: `${prefix}source.tar.zst`,
        artifactPrefix: `${prefix}dist/`,
        manifestKey: `${prefix}manifest.json`,
      })
    )
    objects.set(
      `${prefix}manifest.json`,
      JSON.stringify({
        revision_id: id,
        site_id: orgId,
        org_id: orgId,
        routes: [{ path: "/", file: "index.html" }],
        headers: HEADERS,
        files: {
          "index.html": "a".repeat(64),
          "contact/index.html": "b".repeat(64),
        },
        built_at: new Date().toISOString(),
      })
    )
    objects.set(`${prefix}dist/index.html`, "<h1>Brightclean</h1>")
    objects.set(`${prefix}dist/contact/index.html`, "<p>+15550142</p>")
    objects.set(`${prefix}screenshots/home-390.png`, "png")
    objects.set(`${prefix}source.tar.zst`, "source")
    return { id, assignmentId: assignment.assignmentId }
  }

  it("serves the revision's files with the manifest's headers and nothing else", async () => {
    const orgId = await freshOrg(kit)
    const rev = await revision(orgId)
    const cookie = cookieFor(
      await signPreview(
        { org_id: orgId, revision_id: rev.id, exp: soon() },
        KEY
      )
    )
    const home = await app.request(`${PREVIEW}/`, { headers: cookie }, env)
    expect(home.status).toBe(200)
    expect(await home.text()).toContain("Brightclean")
    expect(Object.fromEntries(home.headers)).toMatchObject({
      ...HEADERS,
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
    })
    const contact = await app.request(
      `${PREVIEW}/contact/`,
      { headers: cookie },
      env
    )
    expect(await contact.text()).toContain("+15550142")
    const shot = await app.request(
      `${PREVIEW}/screenshots/home-390.png`,
      { headers: cookie },
      env
    )
    expect(shot.status).toBe(200)
    expect(shot.headers.get("content-type")).toBe("image/png")
    for (const path of [
      "/source.tar.zst",
      "/manifest.json",
      "/dist/index.html",
    ]) {
      expect(
        (await app.request(`${PREVIEW}${path}`, { headers: cookie }, env))
          .status
      ).toBe(404)
    }
  })

  it("does not serve another org's revision to a token naming it", async () => {
    const orgA = await freshOrg(kit)
    const orgB = await freshOrg(kit)
    const revB = await revision(orgB)
    const forged = await signPreview(
      { org_id: orgA, revision_id: revB.id, exp: soon() },
      KEY
    )
    const res = await app.request(
      `${PREVIEW}/`,
      { headers: cookieFor(forged) },
      env
    )
    expect(res.status).toBe(404)
  })

  it("mints a link behind the bearer that opens that revision", async () => {
    const orgId = await freshOrg(kit)
    const rev = await revision(orgId)
    const slug = `state-test-${orgId.slice(0, 8)}`
    const path = `${CONSOLE}/assignments/${rev.assignmentId}/preview?org=${slug}`
    expect((await app.request(path, {}, env)).status).toBe(401)

    const unconfigured = await app.request(
      path,
      { headers: { authorization: "Bearer test-token" } },
      { ...env, PREVIEW_KEY: "" } as unknown as Env
    )
    expect(unconfigured.status).toBe(503)

    const res = await app.request(
      path,
      { headers: { authorization: "Bearer test-token" } },
      env
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      url: string
      revision_id: string
      screenshots: string[]
    }
    expect(body.revision_id).toBe(rev.id)
    expect(body.screenshots).toHaveLength(3)
    const token = new URL(body.url).searchParams.get("t") ?? ""
    expect(new URL(body.url).host).toBe(PREVIEW_HOST)
    expect(await verifyPreview(token, KEY)).toMatchObject({
      org_id: orgId,
      revision_id: rev.id,
    })
  })
})
