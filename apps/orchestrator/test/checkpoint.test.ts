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
      if (command.startsWith("mkdir -p")) disk.set("site", "restored")
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

const { checkpoint, checkpointKey, endSandbox, rehydrate } = await import(
  "../src/sandbox.ts"
)

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
    delete: async (key: string) => {
      bucket.delete(key)
    },
  },
} as unknown as Env
const ids = { orgId: "org-1", assignmentId: "asg-1" }

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

  it("goes with the container when the build ends", async () => {
    await endSandbox(env, ids)
    expect(destroyed).toBe(1)
    expect(bucket.has(checkpointKey(ids))).toBe(false)
  })
})
