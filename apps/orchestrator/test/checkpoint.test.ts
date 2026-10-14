import { describe, expect, it, vi } from "vitest"

/**
 * A blocked build's site survives its container stopping: the checkpoint
 * lands in R2 at the block, the rehydrate puts it back only when the
 * container lost its disk, and the end of the build removes both.
 */

const disk = new Map<string, string>()
const commands: string[] = []
let destroyed = 0
// Declared rather than written as a class expression in the factory, which
// biome cannot parse there.
const { Unavailable } = vi.hoisted(() => {
  class ContainerUnavailable extends Error {}
  return { Unavailable: ContainerUnavailable }
})
vi.mock("@cloudflare/sandbox", () => ({
  ContainerUnavailableError: Unavailable,
  getSandbox: () => ({
    exec: async (command: string) => {
      commands.push(command)
      if (command.startsWith("test -d")) {
        return { exitCode: disk.has("site") ? 0 : 1, stdout: "", stderr: "" }
      }
      if (command.startsWith("tar --zstd -cf")) {
        disk.set("/tmp/checkpoint.tar.zst", "packed site")
      }
      if (command.includes("tar --zstd -xf")) disk.set("site", "restored")
      return { exitCode: 0, stdout: "", stderr: "" }
    },
    readFile: async (path: string) => ({
      content: btoa(disk.get(path) ?? ""),
    }),
    writeFile: async (path: string, body: unknown) => {
      disk.set(path, String(body))
    },
    destroy: async () => {
      destroyed++
    },
  }),
}))

const { checkpoint, checkpointKey, endSandbox, recover, rehydrate } =
  await import("../src/sandbox.ts")

const bucket = new Map<string, Uint8Array>()
const env = {
  SANDBOX: {},
  SITES: {
    put: async (key: string, body: Uint8Array) => {
      bucket.set(key, body)
    },
    get: async (key: string) => {
      const found = bucket.get(key)
      return found ? { body: new Blob([found]).stream() } : null
    },
    head: async (key: string) => (bucket.has(key) ? {} : null),
    delete: async (key: string) => {
      bucket.delete(key)
    },
  },
} as unknown as Env
const ids = { orgId: "org-1", assignmentId: "asg-1" }

// Open item 56: the platform replaced the container under a running turn.
describe("a turn that comes back to a replaced container", () => {
  const replaced = { orgId: "org-1", assignmentId: "asg-replaced" }

  it("reads nothing from R2 when the disk is still there", async () => {
    disk.set("site", "edited")
    commands.length = 0
    expect(await recover(env, replaced)).toMatchObject({ site: "kept" })
    expect(commands).toEqual(["test -d /workspace/site/.git"])
  })

  it("says the site is gone when nothing was saved, and restores nothing", async () => {
    disk.delete("site")
    commands.length = 0
    expect(await recover(env, replaced)).toMatchObject({ site: "gone" })
    expect(disk.has("site")).toBe(false)
    expect(commands).toHaveLength(1)
  })

  it("puts the last checkpoint back", async () => {
    disk.set("site", "edited")
    await checkpoint(env, replaced)
    disk.delete("site")
    expect(await recover(env, replaced)).toMatchObject({ site: "restored" })
    expect(disk.get("site")).toBe("restored")
    expect(disk.get("/tmp/source.tar.zst")).toBeTruthy()
  })
})

describe("a blocked build's checkpoint", () => {
  it("packs the site into R2 under the assignment's key", async () => {
    disk.set("site", "edited")
    const taken = await checkpoint(env, ids)
    expect(taken.key).toBe("sites/org-1/checkpoints/asg-1.tar.zst")
    expect(new TextDecoder().decode(bucket.get(taken.key))).toBe("packed site")
    expect(commands.at(-1)).toContain("--exclude=./node_modules")
  })

  it("leaves a container that kept its disk alone", async () => {
    commands.length = 0
    expect(await rehydrate(env, ids)).toMatchObject({ restored: false })
    expect(commands).toEqual(["test -d /workspace/site/.git"])
  })

  it("restores the checkpoint into a container that lost it", async () => {
    disk.clear()
    commands.length = 0
    expect(await rehydrate(env, ids)).toMatchObject({ restored: true })
    expect(disk.get("/tmp/source.tar.zst")).toBeDefined()
    expect(commands.at(-1)).toContain("tar --zstd -xf /tmp/source.tar.zst")
  })

  // The container sleeps five minutes after the Developer goes quiet, and the
  // block can reach this later than that. Throwing here would error the
  // Workflow instance and hold the org's site lock until someone cancelled by
  // hand, so a lost site is a report and the Workflow fails the build on it.
  it("reports a site the container already lost, and packs nothing", async () => {
    disk.clear()
    commands.length = 0
    const before = bucket.get(checkpointKey(ids))
    const taken = await checkpoint(env, ids)
    expect(taken).toMatchObject({ taken: false, bytes: 0 })
    expect(commands).toEqual(["test -d /workspace/site/.git"])
    // Nothing packed, and the earlier checkpoint left where it was.
    expect(bucket.get(taken.key)).toBe(before)
  })

  it("goes with the container when the build ends", async () => {
    await endSandbox(env, ids)
    expect(destroyed).toBe(1)
    expect(bucket.has(checkpointKey(ids))).toBe(false)
  })
})
