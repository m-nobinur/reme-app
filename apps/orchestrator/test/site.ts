import { createHash } from "node:crypto"
import type { AssignmentState } from "@workspace/contracts"
import {
  assignments,
  eq,
  events,
  siteRevisions,
  sql,
  supersedeFact,
  type Tenancy,
  tenancy,
} from "@workspace/db"
import { vi } from "vitest"
import { takeSnapshot } from "../src/brief.ts"
import { advance } from "../src/state.ts"
import { freshOrg, newAssignment } from "./fixture.ts"

/**
 * A site in a fake R2 and a fake KV, with an org, its facts and a build at
 * `preview_ready`, for the publish and retention suites. Everything is
 * written the way the orchestrator writes it, through `withOrg`.
 */

const url = process.env.DATABASE_URL
export const kit: Tenancy = tenancy(url ?? "postgres://unused")

export const SUFFIX = "-stg.remeai.co.uk"
export const sha = (bytes: string) =>
  createHash("sha256").update(bytes).digest("hex")
export const HEADERS = { "x-frame-options": "DENY" }
export const GOOD_HTML =
  '<!doctype html><html><head><title>BrightClean</title></head><body><main><h1>BrightClean</h1><p>Weekday cleaning from $35 an hour, call +15550142 to book a visit today.</p><a href="/">Home</a></main></body></html>'

/** A fake R2 holding revisions, and a fake KV holding pointers. */
export function storage() {
  const objects = new Map<string, Uint8Array>()
  const pointers = new Map<string, string>()
  return {
    objects,
    pointers,
    SITES: {
      get: async (key: string) => {
        const bytes = objects.get(key)
        return bytes
          ? {
              arrayBuffer: async () => bytes.slice().buffer,
              json: async () => JSON.parse(new TextDecoder().decode(bytes)),
            }
          : null
      },
      put: async (key: string, value: string) => {
        objects.set(key, new TextEncoder().encode(value))
      },
      // The listing the sweep's delete paginates through, two keys a page.
      list: async ({ prefix, cursor }: { prefix: string; cursor?: string }) => {
        const all = [...objects.keys()]
          .filter((k) => k.startsWith(prefix))
          .sort((a, b) => a.localeCompare(b))
        const at = cursor ? Number(cursor) : 0
        const page = all.slice(at, at + 2)
        const truncated = at + 2 < all.length
        return {
          objects: page.map((key) => ({ key })),
          truncated,
          cursor: truncated ? String(at + 2) : undefined,
        }
      },
      delete: async (keys: string[]) => {
        for (const key of keys) objects.delete(key)
      },
    },
    ROUTES: {
      put: async (key: string, value: string) => {
        pointers.set(key, value)
      },
      get: async (key: string) => pointers.get(key) ?? null,
    },
  }
}

export const FACTS = [
  ["business.name", "identity", { name: "BrightClean" }],
  ["business.phone", "contact", { e164: "+15550142" }],
  [
    "pricing.standard_clean_hourly",
    "pricing",
    { currency: "USD", amount_minor: 3500 },
  ],
] as const

export const TO_PREVIEW: AssignmentState[] = [
  "briefing",
  "planning",
  "implementing",
  "validating",
  "preview_ready",
]

/** An org with facts, one assignment at `preview_ready`, and a preview revision in the fake R2. */
export async function previewed(
  store = storage(),
  html = GOOD_HTML,
  older = 0
) {
  const orgId = await freshOrg(kit)
  const ids = await newAssignment(kit, orgId)
  await kit.withOrg({ orgId }, async (db) => {
    for (const [key, factType, value] of FACTS) {
      await supersedeFact(db, {
        orgId,
        key,
        factType,
        value,
        provenance: { source: "owner_stated", confidence: 1 },
      })
    }
    await takeSnapshot(db, ids, [])
  })
  for (const to of TO_PREVIEW) await advance(kit, ids, to)
  // Older revisions of the same assignment, retired, so a stale id exists.
  const others: string[] = []
  for (let i = 0; i < older; i++) {
    others.push(
      await addRevision(store, orgId, ids.assignmentId, html, "retired")
    )
  }
  const revisionId = await addRevision(store, orgId, ids.assignmentId, html)
  return { orgId, ids, revisionId, store, others }
}

export async function addRevision(
  store: ReturnType<typeof storage>,
  orgId: string,
  assignmentId: string,
  html: string,
  status: "preview" | "building" | "retired" = "preview"
) {
  const id = crypto.randomUUID()
  const prefix = `sites/${orgId}/${id}/`
  const [latest] = await kit.withOrg({ orgId }, (db) =>
    db
      .select({ max: sql<number>`coalesce(max(version), 0)::int` })
      .from(siteRevisions)
      .where(eq(siteRevisions.siteId, orgId))
  )
  await kit.withOrg({ orgId }, (db) =>
    db.insert(siteRevisions).values({
      id,
      orgId,
      siteId: orgId,
      assignmentId,
      version: (latest?.max ?? 0) + 1,
      sourceKey: `${prefix}source.tar.zst`,
      artifactPrefix: `${prefix}dist/`,
      manifestKey: `${prefix}manifest.json`,
      status,
    })
  )
  const files = { "index.html": sha(html) }
  await store.SITES.put(
    `${prefix}manifest.json`,
    JSON.stringify({
      revision_id: id,
      site_id: orgId,
      org_id: orgId,
      routes: [{ path: "/", file: "index.html" }],
      headers: HEADERS,
      files,
      built_at: new Date().toISOString(),
    })
  )
  await store.SITES.put(`${prefix}dist/index.html`, html)
  await store.SITES.put(`${prefix}source.tar.zst`, "source")
  return id
}

export const stateOf = (ids: { orgId: string; assignmentId: string }) =>
  kit.withOrg({ orgId: ids.orgId }, async (db) => {
    const [row] = await db
      .select({ state: assignments.state })
      .from(assignments)
      .where(eq(assignments.id, ids.assignmentId))
    return row?.state
  })

export const eventsOf = (
  ids: { orgId: string; assignmentId: string },
  type: string
) =>
  kit.withOrg({ orgId: ids.orgId }, (db) =>
    db
      .select()
      .from(events)
      .where(
        sql`${events.assignmentId} = ${ids.assignmentId} and ${events.type} = ${type}`
      )
  )

/** A recording step: names in order, every callback run at once, sleeps skipped. */
export function fakeStep(names: string[]) {
  return {
    do: async (name: string, a: unknown, b?: unknown) => {
      names.push(name)
      const fn = (typeof a === "function" ? a : b) as () => Promise<unknown>
      return fn()
    },
    sleep: async (name: string) => {
      names.push(name)
    },
  } as never
}

export function workflowEnv(store: ReturnType<typeof storage>) {
  const created: string[] = []
  return {
    created,
    env: {
      HYPERDRIVE: { connectionString: url },
      SITES: store.SITES,
      ROUTES: store.ROUTES,
      SITE_HOST_SUFFIX: SUFFIX,
      CONSOLE_APPROVALS: "allow",
      ASSIGNMENTS: {
        get: async () => ({ status: async () => ({ status: "complete" }) }),
        create: async ({ id }: { id: string }) => {
          created.push(id)
          return { id }
        },
      },
    } as unknown as Env,
  }
}

/** The page the fake router serves for a host: whatever the pointer names, from the fake R2. */
export function serveFromPointer(
  store: ReturnType<typeof storage>,
  override?: () => Response | null
) {
  return vi.fn(async (input: string | URL | Request) => {
    const forced = override?.()
    if (forced) return forced
    const host = new URL(String(input)).hostname
    const raw = store.pointers.get(`host:${host}`)
    if (!raw) return new Response("No site here.", { status: 404 })
    const pointer = JSON.parse(raw) as { site_id: string; revision_id: string }
    const object = store.objects.get(
      `sites/${pointer.site_id}/${pointer.revision_id}/dist/index.html`
    )
    return object
      ? new Response(new TextDecoder().decode(object), { status: 200 })
      : new Response("", { status: 404 })
  })
}
