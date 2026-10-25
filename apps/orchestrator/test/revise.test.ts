import { assignments, eq, siteRevisions } from "@workspace/db"
import { afterAll, describe, expect, it, vi } from "vitest"
import { newAssignment } from "./fixture.ts"

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {
    env: unknown
    constructor(_ctx: unknown, env: unknown) {
      this.env = env
    }
  },
}))
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class NonRetryableError extends Error {},
}))
vi.mock("../src/container.ts", () => ({
  RemeSandbox: class {},
  SandboxEgress: class {},
  SandboxPool: class {},
}))
vi.mock("../src/sandbox.ts", () => ({
  NPM_REGISTRY_HOST: "registry.npmjs.org",
  SLEEP_AFTER: "5m",
  PoolExhaustedError: class PoolExhaustedError extends Error {},
  provision: async () => ({ cold_start_ms: 1 }),
  sandboxFor: () => ({ destroy: async () => undefined }),
}))
vi.mock("../src/agents/developer.ts", () => ({ Developer: {} }))

const { placePhotos, publishedSource, restoreAndMap, reviseSource } =
  await import("../src/revise.ts")
const { advance, cancel } = await import("../src/state.ts")
const { photoKey } = await import("../src/photo-files.ts")
const { activate } = await import("../src/publish.ts")
const { default: app } = await import("../src/app.ts")
const {
  addRevision,
  eventsOf,
  GOOD_HTML,
  kit,
  previewed,
  stateOf,
  storage,
  TO_PREVIEW,
} = await import("./site.ts")

const url = process.env.DATABASE_URL
const live = describe.skipIf(!url)
afterAll(() => kit.close())

describe("restoring the published snapshot into the container", () => {
  it("extracts the tarball, links the toolchain and maps the restored files", async () => {
    const commands: string[] = []
    const written: string[] = []
    const files: Record<string, string> = {
      "./src/site-config.ts":
        'export const site = {\n  name: "BrightClean",\n}\n',
      "./src/pages/index.astro":
        '---\nimport Base from "../layouts/Base.astro"\nconst title = site.name\n---\n',
      "./astro.config.mjs": "export default {}\n",
    }
    const sandbox = {
      exec: async (command: string) => {
        commands.push(command)
        return {
          exitCode: 0,
          stdout: command.includes("find .")
            ? `${Object.keys(files).join("\n")}\n`
            : "",
          stderr: "",
        }
      },
      writeFile: async (path: string) => {
        written.push(path)
      },
      readFile: async (path: string) => ({
        content: files[`.${path.replace("/workspace/site", "")}`] ?? "",
      }),
    }
    const sites = {
      get: async (key: string) =>
        key === "sites/x/y/source.tar.zst"
          ? { body: new ReadableStream<Uint8Array>() }
          : null,
    }
    const map = await restoreAndMap(sandbox, sites, "sites/x/y/source.tar.zst")
    expect(written).toEqual(["/tmp/source.tar.zst"])
    expect(commands[0]).toContain(
      "tar --zstd -xf /tmp/source.tar.zst -C /workspace/site"
    )
    expect(commands[0]).toContain(
      "ln -sfn /opt/astro/node_modules node_modules"
    )
    expect(map).toContain("src/site-config.ts")
    expect(map).toContain("exports site {name}")
    expect(map).toContain("src/pages/index.astro")
    expect(map).toContain("astro.config.mjs")
    await expect(
      restoreAndMap(sandbox, sites, "sites/x/z/source.tar.zst")
    ).rejects.toThrow("no source snapshot")
  })
})

describe("the owner's photos in the container", () => {
  const photo = (id: string, type: string) => ({
    id,
    name: "p.jpg",
    content_type: type,
    bytes: 3,
  })
  const facts = [
    {
      fact_id: "10000001-0000-4000-8000-000000000001",
      org_id: "10000001-0000-4000-8000-000000000000",
      key: "media.uploads",
      fact_type: "media",
      value: {
        items: [
          photo("3f2b9c1e-8a4d-4f6b-9c2a-1d5e7f8a9b0c", "image/jpeg"),
          {
            ...photo("3f2b9c1e-8a4d-4f6b-9c2a-1d5e7f8a9b0d", "image/webp"),
            use: "logo",
          },
        ],
      },
      version: 1,
      provenance: {
        source: "owner_stated" as const,
        confidence: 1,
        verified_by_staff_id: null,
        verified_at: null,
      },
      valid_from: "2026-09-18T12:00:00.000Z",
      valid_to: null,
      superseded_by_fact_id: null,
    },
  ]

  it("copies each from the org's uploads into src/assets/uploads, the logo too, and names the ones it cannot find", async () => {
    const commands: string[] = []
    const written: [string, number][] = []
    const sandbox = {
      exec: async (command: string) => {
        commands.push(command)
      },
      writeFile: async (path: string, content: Uint8Array) => {
        written.push([path, content.byteLength])
      },
    }
    const asked: string[] = []
    const sites = {
      get: async (key: string) => {
        asked.push(key)
        return key.endsWith("b0c")
          ? { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }
          : null
      },
    }
    const missing = await placePhotos(sandbox, sites, "org-1", facts)
    expect(commands).toEqual(["mkdir -p /workspace/site/src/assets/uploads"])
    expect(asked).toEqual([
      photoKey("org-1", "3f2b9c1e-8a4d-4f6b-9c2a-1d5e7f8a9b0c"),
      photoKey("org-1", "3f2b9c1e-8a4d-4f6b-9c2a-1d5e7f8a9b0d"),
    ])
    expect(asked[0]).toBe("uploads/org-1/3f2b9c1e-8a4d-4f6b-9c2a-1d5e7f8a9b0c")
    expect(written).toEqual([
      [
        "/workspace/site/src/assets/uploads/3f2b9c1e-8a4d-4f6b-9c2a-1d5e7f8a9b0c.jpg",
        3,
      ],
    ])
    expect(missing).toEqual(["3f2b9c1e-8a4d-4f6b-9c2a-1d5e7f8a9b0d"])
    expect(await placePhotos(sandbox, sites, "org-1", [])).toEqual([])
    expect(commands).toHaveLength(1)
  })
})

live("a revise", () => {
  const CONSOLE = "https://staging-orchestrator.remeai.co.uk"
  const env = {
    ORCHESTRATOR_TOKEN: "test-token",
    HYPERDRIVE: { connectionString: url ?? "postgres://stub" },
    ASSIGNMENTS: { create: async ({ id }: { id: string }) => ({ id }) },
  } as unknown as Env
  const post = (slug: string, body: unknown) =>
    app.request(
      `${CONSOLE}/assignments?org=${slug}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "idempotency-key": crypto.randomUUID(),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      env
    )

  it("starts from the revision the site serves, names the build it revises, and taints the request", async () => {
    const store = storage()
    const built = await previewed(store)
    const { orgId, ids, revisionId } = built
    const slug = `state-test-${orgId.slice(0, 8)}`
    // Before a publish there is nothing to revise.
    const early = await post(slug, {
      kind: "site.revise",
      goal: "Make it warmer",
    })
    expect(early.status).toBe(409)
    expect(await early.json()).toMatchObject({ code: "site.not_published" })
    expect((await post(slug, { kind: "site.revise" })).status).toBe(400)

    await kit.withOrg({ orgId }, (db) =>
      activate(db, orgId, {
        id: crypto.randomUUID(),
        siteId: orgId,
        revisionId,
        kind: "rollback",
        reason: "probe",
      })
    )
    const source = await kit.withOrg({ orgId }, (db) =>
      publishedSource(db, orgId)
    )
    expect(source).toEqual({
      revision_id: revisionId,
      assignment_id: ids.assignmentId,
      source_key: `sites/${orgId}/${revisionId}/source.tar.zst`,
    })
    // A newer preview on another build does not move the source: the site serves the published one.
    const other = await newAssignment(kit, orgId)
    await addRevision(store, orgId, other.assignmentId, GOOD_HTML)
    expect(
      (await kit.withOrg({ orgId }, (db) => publishedSource(db, orgId)))
        ?.revision_id
    ).toBe(revisionId)

    const res = await post(slug, {
      kind: "site.revise",
      goal: "Change the weekday closing time to 6pm",
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      assignment_id: string
      kind: string
      revision_of_assignment_id: string | null
      goal: string
    }
    expect(body.kind).toBe("site.revise")
    expect(body.revision_of_assignment_id).toBe(ids.assignmentId)
    expect(body.goal).toBe("Change the weekday closing time to 6pm")
    const [row] = await kit.withOrg({ orgId }, (db) =>
      db
        .select()
        .from(assignments)
        .where(eq(assignments.id, body.assignment_id))
    )
    expect(row?.revisionOfAssignmentId).toBe(ids.assignmentId)
    const created = await eventsOf(
      { orgId, assignmentId: body.assignment_id },
      "assignment.created"
    )
    expect(created).toHaveLength(1)
    expect(created[0]?.taint).toContain("untrusted_input")
    expect(created[0]?.payload).toMatchObject({
      kind: "site.revise",
      revises_revision_id: revisionId,
    })
    // A build carries no taint and no link.
    const build = await post(slug, { kind: "site.build" })
    expect(build.status).toBe(201)
    const buildBody = (await build.json()) as {
      assignment_id: string
      revision_of_assignment_id: string | null
    }
    expect(buildBody.revision_of_assignment_id).toBeNull()
    const buildCreated = await eventsOf(
      { orgId, assignmentId: buildBody.assignment_id },
      "assignment.created"
    )
    expect(buildCreated[0]?.taint).toEqual([])
    // The published revision row is what the revise restores; its status is unchanged by the create.
    const [revision] = await kit.withOrg({ orgId }, (db) =>
      db.select().from(siteRevisions).where(eq(siteRevisions.id, revisionId))
    )
    expect(revision?.status).toBe("published")
  })

  it("revises the owner's draft before the site is live, holding it until the change is ready, and gives it back if the change stops", async () => {
    const built = await previewed(storage())
    const { orgId, ids, revisionId } = built
    const slug = `state-test-${orgId.slice(0, 8)}`
    await advance(kit, ids, "awaiting_review")
    const statusOf = async (id: string) =>
      (
        await kit.withOrg({ orgId }, (db) =>
          db.select().from(siteRevisions).where(eq(siteRevisions.id, id))
        )
      )[0]?.status
    const change = async () => {
      const res = await post(slug, {
        kind: "site.revise",
        goal: "Add Sundays",
        draft_revision_id: revisionId,
        label: " your opening hours ",
      })
      expect(res.status).toBe(201)
      const body = (await res.json()) as {
        assignment_id: string
        revision_of_assignment_id: string | null
      }
      expect(body.revision_of_assignment_id).toBe(ids.assignmentId)
      return { orgId, assignmentId: body.assignment_id }
    }
    // Only a revise names a draft.
    const build = await post(slug, {
      kind: "site.build",
      draft_revision_id: revisionId,
    })
    expect(build.status).toBe(400)

    const first = await change()
    expect(await stateOf(ids)).toBe("paused")
    const [created] = await eventsOf(first, "assignment.created")
    expect(created?.payload).toMatchObject({
      revises_revision_id: revisionId,
      draft_revision_id: revisionId,
      label: "your opening hours",
    })
    expect(
      await kit.withOrg({ orgId }, (db) => reviseSource(db, first))
    ).toEqual({
      revision_id: revisionId,
      assignment_id: ids.assignmentId,
      source_key: `sites/${orgId}/${revisionId}/source.tar.zst`,
    })
    // The draft is held: a second change on it is refused, not stacked.
    const again = await post(slug, {
      kind: "site.revise",
      goal: "Add Mondays",
      draft_revision_id: revisionId,
    })
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ code: "change.draft_moved" })

    // Stop: the draft is back in front of the owner, its preview kept.
    await cancel(kit, first, "stopped by the owner")
    expect(await stateOf(ids)).toBe("awaiting_review")
    expect(await statusOf(revisionId)).toBe("preview")

    // A change that reaches its own review takes the draft's place.
    const second = await change()
    for (const to of TO_PREVIEW) await advance(kit, second, to)
    expect(await stateOf(ids)).toBe("paused")
    await advance(kit, second, "awaiting_review")
    expect(await stateOf(ids)).toBe("cancelled")
    expect(await statusOf(revisionId)).toBe("retired")
    await cancel(kit, second)
    expect(await stateOf(ids)).toBe("cancelled")
  })
})
