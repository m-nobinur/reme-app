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
vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  ContainerProxy: class {},
}))
vi.mock("../src/sandbox.ts", () => ({
  NPM_REGISTRY_HOST: "registry.npmjs.org",
  SLEEP_AFTER: "5m",
  PoolExhaustedError: class PoolExhaustedError extends Error {},
  provision: async () => ({ cold_start_ms: 1 }),
  sandboxFor: () => ({ destroy: async () => undefined }),
}))
vi.mock("../src/agents/developer.ts", () => ({ Developer: {} }))

const { publishedSource, restoreAndMap } = await import("../src/revise.ts")
const { activate } = await import("../src/publish.ts")
const { default: app } = await import("../src/app.ts")
const { addRevision, eventsOf, GOOD_HTML, kit, previewed, storage } =
  await import("./site.ts")

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
})
