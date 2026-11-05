import { describe, expect, it } from "vitest"

// workerd's FixedLengthStream as a pass-through: these tests run on Node.
Object.assign(globalThis, {
  FixedLengthStream: class extends TransformStream {
    constructor(_length: number) {
      super()
    }
  },
})

/**
 * A blocked build's site survives its container stopping: the checkpoint
 * lands in R2 at the block, the rehydrate puts it back only when the
 * container lost its disk, and the end of the build removes both.
 */

const disk = new Map<string, string>()
const commands: string[] = []
const reads: string[] = []
let destroyed = 0
/** The site's `RemeSandbox` stub, as `getByName` returns it. */
const stub = {
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
  readFile: async (path: string) => {
    reads.push(path)
    return { content: btoa(disk.get(path) ?? "") }
  },
  saveFile: async (path: string, key: string) => {
    const body = new TextEncoder().encode(disk.get(path) ?? "")
    bucket.set(key, body)
    return body.length
  },
  writeFile: async (path: string, body: unknown) => {
    disk.set(path, String(body))
  },
  destroy: async () => {
    destroyed++
  },
}

const {
  checkpoint,
  checkpointKey,
  endSandbox,
  recover,
  rehydrate,
  takeWork,
  workKey,
} = await import("../src/sandbox.ts")

const bucket = new Map<string, Uint8Array | ArrayBuffer>()
const env = {
  SANDBOX: { getByName: () => stub },
  SITES: {
    put: async (key: string, body: Uint8Array | ReadableStream) => {
      bucket.set(
        key,
        body instanceof ReadableStream
          ? new Uint8Array(await new Response(body).arrayBuffer())
          : body
      )
    },
    get: async (key: string) => {
      const found = bucket.get(key)
      return found
        ? {
            size: new Blob([found]).size,
            body: new Blob([found]).stream(),
            arrayBuffer: () => new Blob([found]).arrayBuffer(),
          }
        : null
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
    expect(taken.bytes).toBe("packed site".length)
    expect(commands.at(-1)).toContain("--exclude=./node_modules")
  })

  // #593: a 13 MB tar read back as base64 and decoded in the Developer's
  // isolate ran it out of memory, so the tar goes to R2 from the sandbox.
  it("never reads the tar back through the caller", async () => {
    disk.set("site", "edited")
    reads.length = 0
    await checkpoint(env, ids)
    expect(reads).toEqual([])
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

describe("a failed build's kept site", () => {
  it("moves to its retry's checkpoint once, which a replay still finds", async () => {
    const failed = { orgId: "org-1", assignmentId: "asg-failed" }
    const retry = { orgId: "org-1", assignmentId: "asg-retry" }
    bucket.set(workKey(failed), new Uint8Array([1, 2]))
    expect(await takeWork(env.SITES, failed, retry)).toBe(true)
    expect(bucket.has(workKey(failed))).toBe(false)
    expect(
      new Uint8Array(bucket.get(checkpointKey(retry)) as ArrayBuffer)
    ).toEqual(new Uint8Array([1, 2]))
    expect(await takeWork(env.SITES, failed, retry)).toBe(true)
    const fresh = { orgId: "org-1", assignmentId: "asg-fresh" }
    expect(await takeWork(env.SITES, failed, fresh)).toBe(false)
  })
})
