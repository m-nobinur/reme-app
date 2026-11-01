import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

/**
 * What change-fidelity needs to run against a local measured build, where
 * there is no router, no DNS and no published site. Used only when
 * FIDELITY_LOCAL_STATE names the orchestrator's local state directory (see
 * the eval's header); staging runs never load it.
 */

/** The revision a signed preview link names: its `t` token is base64url JSON, then a signature. */
export const claimOf = (token) =>
  JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString())

/** The built files a site path can be: `/` and `/about/` are index pages. */
export function filesFor(path) {
  const rel = path.replace(/^\//, "")
  if (!rel || rel.endsWith("/")) return [`${rel}index.html`]
  return [rel, `${rel}/index.html`]
}

export async function localSites({ state, slug, orchestrator }) {
  const { connect } = await import("../../packages/db/src/client.ts")
  const schema = await import("../../packages/db/src/schema.ts")
  const { rootStaffId } = await import("../../packages/db/src/staff.ts")
  const { ENTER_APP_ROLE, setContext } = await import(
    "../../packages/db/src/tenancy.ts"
  )
  const { sql, db } = connect()
  const [org] = await sql`select id from orgs where slug = ${slug}`
  if (!org) throw new Error(`no org ${slug} in the local database`)
  const orgId = org.id

  const r2 = join(state, "v3/r2")
  const objects = join(r2, "miniflare-R2BucketObject")
  const sqlite = readdirSync(objects).find((f) => /^3.*\.sqlite$/.test(f))
  const fromR2 = (revision, path) => {
    const store = new DatabaseSync(join(objects, sqlite), { readOnly: true })
    try {
      for (const file of filesFor(path)) {
        const row = store
          .prepare("select blob_id from _mf_objects where key = ?")
          .get(`sites/${orgId}/${revision}/dist/${file}`)
        if (row) return readFileSync(join(r2, "reme-sites/blobs", row.blob_id))
      }
      return null
    } finally {
      store.close()
    }
  }

  const revisionOfHost = new Map()
  const origin = new URL(orchestrator).origin
  const real = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : (input.url ?? input.href)
    )
    if (url.origin === origin) return real(input, init)
    const token = url.searchParams.get("t")
    if (token) revisionOfHost.set(url.host, claimOf(token).revision_id)
    if (url.pathname === "/open") return new Response("", { status: 200 })
    const revision = revisionOfHost.get(url.host)
    const file = revision && fromR2(revision, url.pathname)
    return file
      ? new Response(file, { status: 200 })
      : new Response("not found", { status: 404 })
  }

  return {
    /** The host serves this revision, as the router would for the published site. */
    serve: (host, revision) => revisionOfHost.set(host, revision),

    /** Makes the org's newest built revision its site, when it has none; DB only, as measure-build does. */
    async activate() {
      const [current] =
        await sql`select 1 from deployments where site_id = ${orgId} limit 1`
      if (current) return
      const [built] =
        await sql`select id from site_revisions where org_id = ${orgId} and version is not null order by created_at desc limit 1`
      if (!built)
        throw new Error(`${slug} has no built revision; build it first`)
      await sql`insert into deployments ${sql({
        org_id: orgId,
        site_id: orgId,
        revision_id: built.id,
        previous_revision_id: null,
        config_version: 1,
        kind: "rollback",
        reason: "local fidelity base; never published",
      })}`
    },

    /** A fact the console cannot create, put in as the owner's, the way measure-build seeds them. */
    async seedFact(key, value) {
      await db.transaction(async (tx) => {
        await tx.execute(ENTER_APP_ROLE)
        await tx.execute(setContext({ orgId }))
        const now = new Date()
        await tx.insert(schema.facts).values({
          orgId,
          key,
          factType: key.split(".")[0],
          value,
          provenanceSource: "owner_stated",
          provenanceConfidence: 1,
          verifiedByStaffId: await rootStaffId(tx),
          verifiedAt: now,
          validFrom: now,
        })
      })
    },

    /** Every version of a fact the run seeded, so the next run starts without it. */
    dropFact: (key) =>
      sql`delete from facts where org_id = ${orgId} and key = ${key}`,

    close: () => sql.end(),
  }
}
