import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * A site's sandbox stays warm after `preview_ready` (QE2): it names the
 * revision on its disk, a full pool evicts the least recently edited warm
 * one before a build waits, and only the assignment holding it ends it.
 */

const { Unavailable } = vi.hoisted(() => {
  class ContainerUnavailable extends Error {
    constructor(readonly reason: string) {
      super(reason)
    }
  }
  return { Unavailable: ContainerUnavailable }
})
const files = new Map<string, string>()
const destroyed: string[] = []
/** Sites whose next `exec` the platform refuses for a full pool. */
const refuse = new Set<string>()
/** Sites whose container came back with the image's empty disk. */
const lost = new Set<string>()
vi.mock("@cloudflare/sandbox", () => ({
  ContainerUnavailableError: Unavailable,
  getSandbox: (_ns: unknown, id: string) => ({
    exec: async (command: string) => {
      if (refuse.delete(id)) {
        throw new Unavailable("no_container_instance_available")
      }
      if (command.startsWith("test -d")) {
        return { exitCode: lost.has(id) ? 1 : 0, stdout: "", stderr: "" }
      }
      if (command.startsWith("cat ")) {
        const held = files.get(`${id}:revision`) ?? ""
        files.delete(`${id}:revision`)
        return { exitCode: 0, stdout: held, stderr: "" }
      }
      return { exitCode: 0, stdout: "", stderr: "" }
    },
    writeFile: async (path: string, body: string) => {
      if (path.endsWith("/.reme/revision")) files.set(`${id}:revision`, body)
    },
    destroy: async () => {
      destroyed.push(id)
    },
  }),
}))

const { endSandbox, keepWarm, PoolExhaustedError, provision, takeWarm } =
  await import("../src/sandbox.ts")
const { getSandbox } = await import("@cloudflare/sandbox")

type Entry = {
  uploaded: Date
  etag: string
  customMetadata: Record<string, string>
}
const bucket = new Map<string, Entry>()
let writes = 0
/** Runs before a `head`, to land a write between the listing and the act. */
let beforeHead: ((key: string) => Promise<void>) | null = null
let now = Date.parse("2026-10-14T09:00:00Z")
const env = {
  SANDBOX: {},
  SITES: {
    put: async (
      key: string,
      _body: unknown,
      options?: { customMetadata?: Record<string, string> }
    ) => {
      bucket.set(key, {
        uploaded: new Date(now),
        etag: `e${++writes}`,
        customMetadata: options?.customMetadata ?? {},
      })
    },
    head: async (key: string) => {
      await beforeHead?.(key)
      return bucket.get(key) ?? null
    },
    delete: async (key: string) => {
      bucket.delete(key)
    },
    list: async ({ prefix }: { prefix: string }) => ({
      objects: [...bucket.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, entry]) => ({ key, ...entry })),
      truncated: false,
    }),
  },
} as unknown as Env
const minutes = (n: number) => n * 60 * 1000
const sandbox = (site: string) => getSandbox(env.SANDBOX as never, site)

beforeEach(() => {
  bucket.clear()
  files.clear()
  destroyed.length = 0
  refuse.clear()
  lost.clear()
  beforeHead = null
  now = Date.parse("2026-10-14T09:00:00Z")
  vi.setSystemTime(now)
})

describe("a warm sandbox", () => {
  it("names the revision it was left with, once", async () => {
    await keepWarm(env, { orgId: "site-a", assignmentId: "a1" }, "rev-1")
    expect(bucket.get("sandboxes/site-a")?.customMetadata).toEqual({
      holder: "a1",
      revision: "rev-1",
    })
    expect(await takeWarm(sandbox("site-a"))).toBe("rev-1")
    // Taken: a build that changes the disk and never previews leaves no claim.
    expect(await takeWarm(sandbox("site-a"))).toBeNull()
  })

  it("is not left warm on a disk that lost the site", async () => {
    await provision(env, { orgId: "site-a", assignmentId: "a1" })
    lost.add("site-a")
    await keepWarm(env, { orgId: "site-a", assignmentId: "a1" }, "rev-1")
    expect(await takeWarm(sandbox("site-a"))).toBeNull()
    expect(destroyed).toEqual(["site-a"])
    expect(bucket.has("sandboxes/site-a")).toBe(false)
  })

  it("stops being evictable once a build holds it", async () => {
    await keepWarm(env, { orgId: "site-a", assignmentId: "a1" }, "rev-1")
    await provision(env, { orgId: "site-a", assignmentId: "a2" })
    expect(bucket.get("sandboxes/site-a")?.customMetadata).toEqual({
      holder: "a2",
    })
  })
})

describe("a full pool", () => {
  it("evicts the least recently edited warm sandbox and starts", async () => {
    // site-old slept long ago; site-b is the oldest still awake.
    await keepWarm(env, { orgId: "site-old", assignmentId: "o1" }, "r")
    now += minutes(40)
    await keepWarm(env, { orgId: "site-b", assignmentId: "b1" }, "r")
    now += minutes(5)
    await keepWarm(env, { orgId: "site-c", assignmentId: "c1" }, "r")
    // A build mid-flight is never a candidate, however old.
    await provision(env, { orgId: "site-busy", assignmentId: "x1" })
    now += minutes(5)
    vi.setSystemTime(now)
    refuse.add("site-new")
    const got = await provision(env, { orgId: "site-new", assignmentId: "n1" })
    expect(got.evicted).toBe("site-b")
    expect(destroyed).toEqual(["site-b"])
    expect(bucket.has("sandboxes/site-b")).toBe(false)
    // The stale entry is pruned without a destroy: it holds no slot.
    expect(bucket.has("sandboxes/site-old")).toBe(false)
    expect(bucket.has("sandboxes/site-c")).toBe(true)
    expect(bucket.has("sandboxes/site-busy")).toBe(true)
  })

  it("passes over a warm sandbox its own site's build took since the listing", async () => {
    await keepWarm(env, { orgId: "site-b", assignmentId: "b1" }, "r")
    now += minutes(5)
    await keepWarm(env, { orgId: "site-c", assignmentId: "c1" }, "r")
    beforeHead = async (key) => {
      if (key !== "sandboxes/site-b") return
      beforeHead = null
      await provision(env, { orgId: "site-b", assignmentId: "b2" })
    }
    refuse.add("site-new")
    const got = await provision(env, { orgId: "site-new", assignmentId: "n1" })
    expect(got.evicted).toBe("site-c")
    expect(destroyed).toEqual(["site-c"])
    expect(bucket.get("sandboxes/site-b")?.customMetadata).toEqual({
      holder: "b2",
    })
  })

  it("waits, as before, when nothing is warm", async () => {
    refuse.add("site-new")
    await expect(
      provision(env, { orgId: "site-new", assignmentId: "n1" })
    ).rejects.toBeInstanceOf(PoolExhaustedError)
    expect(destroyed).toEqual([])
  })
})

describe("ending a site's sandbox", () => {
  it("leaves the running build's container when a queued one is cancelled", async () => {
    await provision(env, { orgId: "site-a", assignmentId: "running" })
    await endSandbox(env, { orgId: "site-a", assignmentId: "queued" })
    expect(destroyed).toEqual([])
    await endSandbox(env, { orgId: "site-a", assignmentId: "running" })
    expect(destroyed).toEqual(["site-a"])
    expect(bucket.has("sandboxes/site-a")).toBe(false)
  })
})
