import { PreviewClaim } from "@workspace/contracts"
import { verifyPreview } from "@workspace/gates/preview"
import { describe, expect, it, vi } from "vitest"
import { previewHost } from "../src/seed.ts"
import { freshOrg, newAssignment } from "./fixture.ts"

const SUFFIX = "-stg.remeai.co.uk"

describe("the preview host", () => {
  it("fits a DNS label at the longest slug staging allows", () => {
    const slug = `${"a".repeat(35)}-${"b".repeat(8)}`
    expect(slug).toHaveLength(44)
    const host = previewHost(slug, 9999, SUFFIX)
    const [label] = host.split(".")
    expect(label?.length).toBeLessThanOrEqual(63)
    expect(
      PreviewClaim.safeParse({
        org_id: "10000001-0000-4000-8000-000000000001",
        site_id: "10000001-0000-4000-8000-000000000001",
        revision_id: "10000001-0000-4000-8000-000000000003",
        host,
        scope: "site",
        exp: 1,
      }).success
    ).toBe(true)
  })

  it("refuses what is not a slug, a suffix or a version", () => {
    expect(() => previewHost("Bright Clean", 1, SUFFIX)).toThrow()
    expect(() => previewHost("brightclean", 0, SUFFIX)).toThrow()
    expect(() => previewHost("brightclean", 1.5, SUFFIX)).toThrow()
    expect(() => previewHost("brightclean", 1, "remeai.co.uk")).toThrow()
  })
})

// The mint route reaches neither a container nor an agent; both modules bind
// to Cloudflare at import time, so they are stood in for as in the app suite.
vi.mock("../src/sandbox.ts", () => ({
  probe: async () => {
    throw new Error("no container in this suite")
  },
  sandboxFor: () => ({ destroy: async () => undefined }),
}))
vi.mock("../src/agents/developer.ts", () => ({ Developer: {} }))

const { default: app } = await import("../src/app.ts")
const { eq, siteRevisions, tenancy } = await import("@workspace/db")

const KEY = "preview-key-for-this-suite-only"
const CONSOLE = "https://staging-orchestrator.remeai.co.uk"
const url = process.env.DATABASE_URL
const env = {
  ORCHESTRATOR_TOKEN: "test-token",
  PREVIEW_KEY: KEY,
  SITE_HOST_SUFFIX: SUFFIX,
  HYPERDRIVE: { connectionString: url ?? "postgres://stub" },
} as unknown as Env
const authed = { headers: { authorization: "Bearer test-token" } }

const live = describe.skipIf(!url)

live("minting a preview link, against a real database", () => {
  const kit = tenancy(url ?? "postgres://unused")

  async function revision(orgId: string, version = 1) {
    const assignment = await newAssignment(kit, orgId)
    const id = crypto.randomUUID()
    const prefix = `sites/${orgId}/${id}/`
    await kit.withOrg({ orgId }, (db) =>
      db.insert(siteRevisions).values({
        id,
        orgId,
        siteId: orgId,
        assignmentId: assignment.assignmentId,
        version,
        sourceKey: `${prefix}source.tar.zst`,
        artifactPrefix: `${prefix}dist/`,
        manifestKey: `${prefix}manifest.json`,
      })
    )
    return { id, assignmentId: assignment.assignmentId }
  }

  it("signs the org, the site, the revision and its host, behind the bearer", async () => {
    const orgId = await freshOrg(kit)
    const rev = await revision(orgId, 3)
    await kit.withOrg({ orgId }, (db) =>
      db
        .update(siteRevisions)
        .set({ status: "preview" })
        .where(eq(siteRevisions.id, rev.id))
    )
    const slug = `state-test-${orgId.slice(0, 8)}`
    const path = `${CONSOLE}/assignments/${rev.assignmentId}/preview?org=${slug}`
    expect((await app.request(path, {}, env)).status).toBe(401)
    const unconfigured = await app.request(path, authed, {
      ...env,
      PREVIEW_KEY: "",
    } as unknown as Env)
    expect(unconfigured.status).toBe(503)

    const res = await app.request(path, authed, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      url: string
      revision_id: string
      screenshots: string[]
    }
    expect(body.revision_id).toBe(rev.id)
    const host = `preview-v3-${slug}${SUFFIX}`
    expect(new URL(body.url).host).toBe(host)
    expect(body.screenshots.map((s) => s.split("?")[0])).toEqual([
      `https://${host}/screenshots/home-390.png`,
      `https://${host}/screenshots/home-768.png`,
      `https://${host}/screenshots/home-1440.png`,
    ])
    const token = new URL(body.url).searchParams.get("t") ?? ""
    expect(await verifyPreview(token, KEY, "site")).toMatchObject({
      org_id: orgId,
      site_id: orgId,
      revision_id: rev.id,
      host,
    })
    // The screenshots carry their own claim, which opens no page.
    const [shot = ""] = body.screenshots
    const shots = new URL(shot).searchParams.get("t") ?? ""
    expect(await verifyPreview(shots, KEY, "site")).toBeNull()
    expect(await verifyPreview(shots, KEY, "screenshots")).toMatchObject({
      revision_id: rev.id,
      host,
    })
  })

  it("refuses a revision that is still building, and an assignment with none", async () => {
    const orgId = await freshOrg(kit)
    const slug = `state-test-${orgId.slice(0, 8)}`
    const rev = await revision(orgId)
    const building = await app.request(
      `${CONSOLE}/assignments/${rev.assignmentId}/preview?org=${slug}`,
      authed,
      env
    )
    expect(building.status).toBe(409)
    expect(await building.json()).toMatchObject({ code: "revision.building" })
    const bare = await newAssignment(kit, orgId)
    const none = await app.request(
      `${CONSOLE}/assignments/${bare.assignmentId}/preview?org=${slug}`,
      authed,
      env
    )
    expect(none.status).toBe(404)
  })
})
