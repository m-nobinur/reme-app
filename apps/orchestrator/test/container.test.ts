import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The sandbox's Durable Object over a fake container: how it starts one
 * (image, size, egress, CA, sleep), what a command and a file call send it,
 * the egress rule, and the pool of five that replaces 0.12's
 * `max_instances`.
 */

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown
    ) {}
  },
  WorkerEntrypoint: class {},
}))

const { disk, links } = vi.hoisted(() => ({
  disk: new Map<string, Uint8Array>(),
  links: new Set<string>(),
}))
vi.mock("@cloudflare/sandbox", () => {
  const fail = (code: string) => Object.assign(new Error(code), { code })
  const parent = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/"
  return {
    SandboxFileError: {
      is: (e: unknown) => typeof (e as { code?: unknown }).code === "string",
    },
    // A filesystem with directories and nothing else, as `sandbox-shim` reports it.
    Files: class {
      readFile(path: string) {
        const found = disk.get(path)
        if (!found) throw fail("ENOENT")
        return Promise.resolve(new Response(found))
      }
      async writeFile(path: string, content: string | Uint8Array) {
        if (!disk.has(`${parent(path)}/`)) throw fail("ENOENT")
        disk.set(
          path,
          typeof content === "string"
            ? new TextEncoder().encode(content)
            : content
        )
      }
      async mkdir(path: string) {
        disk.set(`${path}/`, new Uint8Array())
      }
      async lstat(path: string) {
        const found = disk.get(path)
        if (!found) throw fail("ENOENT")
        return {
          type: links.has(path) ? "symlink" : "file",
          size: BigInt(found.length),
        }
      }
      async remove(path: string) {
        disk.delete(path)
      }
    },
  }
})

const {
  CONFINED,
  EXEC_SCRIPT,
  FILE_SCRIPTS,
  LEASE_MS,
  RemeSandbox,
  SandboxEgress,
  SandboxPool,
} = await import("../src/container.ts")

const encode = (s: string) => new TextEncoder().encode(s).buffer
type Ran = { argv: string[]; options: Record<string, unknown> | undefined }
type Answer = { exitCode: number; stdout: string | Uint8Array; stderr: string }
/** How a confined command's argv reads: no capability, then bash. */
const shell = [...CONFINED, "bash", "-c", EXEC_SCRIPT]

/** A container as `ctx.container` presents one, scripted per command. */
const fakeContainer = () => {
  const c = {
    running: false as boolean,
    images: { sandbox: "registry.example/reme-sandbox@sha256:abc" },
    started: [] as unknown[],
    ran: [] as Ran[],
    intercepts: [] as string[],
    timeouts: [] as number[],
    destroyed: 0,
    answer: (_argv: string[]): Answer => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }),
    stdin: [] as Uint8Array[],
    start(options: unknown) {
      if (c.running) throw new Error("already running")
      c.running = true
      c.started.push(options)
    },
    async exec(argv: string[], options?: Record<string, unknown>) {
      const { stdin, ...rest } = options ?? {}
      c.ran.push({ argv, options: options && rest })
      if (stdin)
        c.stdin.push(
          new Uint8Array(
            await new Response(stdin as ReadableStream).arrayBuffer()
          )
        )
      const out = c.answer(argv)
      return {
        exitCode: Promise.resolve(out.exitCode),
        output: async () => ({
          exitCode: out.exitCode,
          stdout:
            typeof out.stdout === "string"
              ? encode(out.stdout)
              : out.stdout.slice().buffer,
          stderr: encode(out.stderr),
        }),
      }
    },
    async interceptAllOutboundHttp() {
      c.intercepts.push("http:all")
    },
    async interceptOutboundHttps(addr: string) {
      c.intercepts.push(`https:${addr}`)
    },
    async setInactivityTimeout(ms: number) {
      c.timeouts.push(ms)
    },
    async destroy() {
      c.running = false
      c.destroyed++
    },
  }
  return c
}

/** A pool Durable Object over a Map, the sync storage API's shape. */
const newPool = () => {
  const kv = new Map<string, number>()
  const ctx = {
    storage: {
      kv: {
        get: (k: string) => kv.get(k),
        put: (k: string, v: number) => kv.set(k, v),
        delete: (k: string) => kv.delete(k),
        list: () => kv.entries(),
      },
    },
  }
  return { pool: new SandboxPool(ctx as never, {} as never), kv }
}

let pool: ReturnType<typeof newPool>["pool"]
let slots: Map<string, number>
const newSandbox = (id = "sandbox-1", container = fakeContainer()) => {
  const ctx = {
    container,
    id: { toString: () => id },
    exports: { SandboxEgress: () => ({ egress: true }) },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(),
  }
  const env = {
    SANDBOX_POOL: { getByName: () => pool },
    SITES: {
      put: async (key: string, body: ReadableStream<Uint8Array>) => {
        bucket.set(key, new Uint8Array(await new Response(body).arrayBuffer()))
      },
    },
  }
  return { sandbox: new RemeSandbox(ctx as never, env as never), container }
}
const bucket = new Map<string, Uint8Array>()

beforeEach(() => {
  ;({ pool, kv: slots } = newPool())
  disk.clear()
  vi.useRealTimers()
})

describe("a sandbox's first command", () => {
  it("starts one container with no Internet and sets it up before running", async () => {
    const { sandbox, container } = newSandbox()
    container.answer = (argv) =>
      argv.includes("bash")
        ? { exitCode: 0, stdout: "hi\n", stderr: "" }
        : { exitCode: 0, stdout: "", stderr: "" }
    const result = await sandbox.exec("echo hi")
    expect(container.started).toEqual([
      {
        image: "registry.example/reme-sandbox@sha256:abc",
        instance: { vcpu: 1, memoryMib: 3072, diskMb: 12_000 },
        enableInternet: false,
      },
    ])
    expect(container.intercepts).toEqual(["http:all", "https:*"])
    // The CA is trusted as root, before any command of ours.
    expect(container.ran[0]?.argv[0]).toBe("sh")
    expect(container.ran[0]?.options).toEqual({ user: "0:0" })
    expect(container.timeouts).toEqual([30 * 60 * 1000])
    // Root then gives root the workspace, in the same setup command.
    expect(container.ran[0]?.argv[2]).toContain(
      "chown 0:0 /workspace /home/reme"
    )
    expect(container.ran[1]).toEqual({
      argv: shell,
      options: {
        cwd: "/workspace",
        env: {
          HOME: "/tmp/home",
          PLAYWRIGHT_BROWSERS_PATH: "/opt/pw-browsers",
          NODE_EXTRA_CA_CERTS:
            "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
          ASTRO_TELEMETRY_DISABLED: "1",
          GIT_AUTHOR_NAME: "reme",
          GIT_AUTHOR_EMAIL: "developer@reme.invalid",
          GIT_COMMITTER_NAME: "reme",
          GIT_COMMITTER_EMAIL: "developer@reme.invalid",
          REME_COMMAND: "echo hi",
          REME_CWD: "/workspace",
        },
      },
    })
    expect(result).toEqual({
      success: true,
      exitCode: 0,
      stdout: "hi\n",
      stderr: "",
    })
    expect([...slots.keys()]).toEqual(["sandbox-1"])
  })

  it("sets up once for calls that arrive together", async () => {
    const { sandbox, container } = newSandbox()
    await Promise.all([sandbox.exec("true"), sandbox.exec("true")])
    expect(container.started).toHaveLength(1)
    expect(container.ran.filter((r) => r.argv[0] === "sh")).toHaveLength(1)
  })

  it("starts a new container when the last one slept", async () => {
    const { sandbox, container } = newSandbox()
    await sandbox.exec("true")
    container.running = false
    await sandbox.exec("true")
    expect(container.started).toHaveLength(2)
  })

  it("stops a container it could not set up and frees its slot", async () => {
    const { sandbox, container } = newSandbox()
    container.answer = (argv) => ({
      exitCode: argv[0] === "sh" ? 124 : 0,
      stdout: "",
      stderr: "",
    })
    await expect(sandbox.exec("true")).rejects.toThrow(/intercept CA/)
    expect(container.destroyed).toBe(1)
    expect(slots.size).toBe(0)
  })
})

describe("a command", () => {
  it("runs under GNU timeout and throws as 0.12 did when it runs out", async () => {
    const { sandbox, container } = newSandbox()
    container.answer = (argv) => ({
      exitCode: argv[0] === "timeout" ? 124 : 0,
      stdout: "",
      stderr: "",
    })
    await expect(
      sandbox.exec("astro build", { timeout: 120_000 })
    ).rejects.toThrow("Command timeout after 120000ms")
    expect(container.ran.at(-1)?.argv).toEqual([
      "timeout",
      "--kill-after=5",
      "120",
      ...shell,
    ])
  })

  it("never puts the command in a command line, where its own pkill -f would match it", async () => {
    const { sandbox, container } = newSandbox()
    const script =
      "pkill -f '[a]stro preview' || true; ./node_modules/.bin/astro preview"
    await sandbox.exec(script, { timeout: 120_000 })
    expect(container.ran.at(-1)?.argv.join(" ")).not.toContain("astro")
    expect(container.ran.at(-1)?.options?.env).toMatchObject({
      REME_COMMAND: script,
    })
  })

  it("returns a failure as a result, not a throw", async () => {
    const { sandbox, container } = newSandbox()
    container.answer = (argv) =>
      argv.includes("bash")
        ? { exitCode: 1, stdout: "", stderr: "nope" }
        : { exitCode: 0, stdout: "", stderr: "" }
    expect(await sandbox.exec("test -d /x", { cwd: "/tmp" })).toEqual({
      success: false,
      exitCode: 1,
      stdout: "",
      stderr: "nope",
    })
    // The process starts where it always exists; the shell goes to `cwd`.
    expect(container.ran.at(-1)?.options?.cwd).toBe("/workspace")
    expect(container.ran.at(-1)?.options?.env).toMatchObject({
      REME_CWD: "/tmp",
    })
  })
})

describe("the shell an exec runs", () => {
  // The real script, in a real bash, as the container runs it.
  const run = (cwd: string, command: string) =>
    spawnSync("bash", ["-c", EXEC_SCRIPT], {
      cwd: tmpdir(),
      // The Worker typings require its vars on ProcessEnv; this shell needs three.
      env: {
        PATH: process.env.PATH ?? "",
        REME_CWD: cwd,
        REME_COMMAND: command,
      } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
    })

  it("runs in the cwd it was given", () => {
    const at = mkdtempSync(join(tmpdir(), "reme-cwd-"))
    expect(run(at, "pwd -P").stdout.trim()).toBe(realpathSync(at))
  })

  it("makes a cwd that does not exist yet, then runs there", () => {
    const at = join(mkdtempSync(join(tmpdir(), "reme-cwd-")), "site")
    const result = run(at, "mkdir -p src && pwd -P")
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(realpathSync(at))
    expect(existsSync(join(at, "src"))).toBe(true)
  })

  it("fails with exit 1 and runs nothing when the cwd cannot be made", () => {
    const at = mkdtempSync(join(tmpdir(), "reme-cwd-"))
    const file = join(at, "file")
    writeFileSync(file, "")
    const marker = join(at, "ran")
    const result = run(join(file, "below"), `touch ${marker}`)
    expect(result.status).toBe(1)
    expect(existsSync(marker)).toBe(false)
  })

  it("leaves neither variable to what the command starts", () => {
    const at = mkdtempSync(join(tmpdir(), "reme-cwd-"))
    // Single quotes: the child shell expands them, not this one.
    expect(
      run(at, `bash -c 'echo "[$REME_COMMAND][$REME_CWD]"'`).stdout.trim()
    ).toBe("[][]")
  })
})

// #697: a file call runs as a confined command, so a symlink the Developer
// planted in the site takes a write no further than `reme` may go.
describe("a file call", () => {
  const last = (c: ReturnType<typeof fakeContainer>) => c.ran.at(-1)

  it("writes its bytes on stdin, its path in a variable, confined", async () => {
    const { sandbox, container } = newSandbox()
    await sandbox.writeFile("/workspace/site/src/a.ts", "export {}")
    expect(last(container)?.argv).toEqual(shell)
    expect(last(container)?.options?.env).toMatchObject({
      REME_COMMAND: FILE_SCRIPTS.write,
      REME_PATH: "/workspace/site/src/a.ts",
    })
    expect(new TextDecoder().decode(container.stdin.at(-1))).toBe("export {}")
  })

  it("decodes base64 on the way in and encodes it on the way out", async () => {
    const { sandbox, container } = newSandbox()
    await sandbox.writeFile("/tmp/b.bin", btoa("\u0000ÿ"), {
      encoding: "base64",
    })
    expect([...(container.stdin.at(-1) ?? [])]).toEqual([0, 255])
    container.answer = () => ({
      exitCode: 0,
      stdout: new Uint8Array([0, 255]),
      stderr: "",
    })
    expect(
      await sandbox.readFile("/tmp/b.bin", { encoding: "base64" })
    ).toEqual({ content: btoa("\u0000ÿ") })
    expect(last(container)?.options?.env).toMatchObject({
      REME_COMMAND: FILE_SCRIPTS.read,
    })
  })

  it("throws what the command said when it fails, and answers exists by exit code", async () => {
    const { sandbox, container } = newSandbox()
    container.answer = (argv) => ({
      exitCode: argv.includes("bash") ? 1 : 0,
      stdout: "",
      stderr: "cat: /opt/x: Permission denied\n",
    })
    await expect(sandbox.readFile("/opt/x")).rejects.toThrow(
      "cat: /opt/x: Permission denied"
    )
    expect(await sandbox.exists("/tmp/none")).toEqual({ exists: false })
    container.answer = () => ({ exitCode: 0, stdout: "", stderr: "" })
    expect(await sandbox.exists("/tmp/")).toEqual({ exists: true })
  })

  it("keeps root's capabilities only where the code asks", async () => {
    const { sandbox, container } = newSandbox()
    await sandbox.exec("rm -rf /workspace/site", { privileged: true })
    expect(last(container)?.argv).toEqual(["bash", "-c", EXEC_SCRIPT])
    await sandbox.stopStrays()
    expect(last(container)?.argv).toEqual(["bash", "-c", EXEC_SCRIPT])
    expect(last(container)?.options?.env).toMatchObject({
      REME_COMMAND: expect.stringContaining("CapEff"),
    })
    await sandbox.exec("rm -rf /workspace/site")
    expect(last(container)?.argv).toEqual(shell)
  })

  // #593: R2 takes a stream only when its length is known, and the bytes never
  // become a string in any isolate on the way.
  it("streams a file into the bucket at its known length, never through a link", async () => {
    const lengths: number[] = []
    vi.stubGlobal(
      "FixedLengthStream",
      class extends TransformStream<Uint8Array, Uint8Array> {
        constructor(length: number) {
          super()
          lengths.push(length)
        }
      }
    )
    const { sandbox } = newSandbox()
    disk.set("/tmp/source.tar.zst", new Uint8Array([0, 1, 255]))
    expect(
      await sandbox.saveFile("/tmp/source.tar.zst", "sites/o/r/source")
    ).toBe(3)
    expect([...(bucket.get("sites/o/r/source") ?? [])]).toEqual([0, 1, 255])
    expect(lengths).toEqual([3])
    links.add("/tmp/source.tar.zst")
    await expect(
      sandbox.saveFile("/tmp/source.tar.zst", "sites/o/r/other")
    ).rejects.toThrow("not a plain file")
    expect(bucket.has("sites/o/r/other")).toBe(false)
    links.clear()
    vi.unstubAllGlobals()
  })
})

describe("the file scripts, in a real bash", () => {
  const run = (script: string, path: string, input?: string) =>
    spawnSync("bash", ["-c", script], {
      env: {
        PATH: process.env.PATH ?? "",
        REME_PATH: path,
      } as unknown as NodeJS.ProcessEnv,
      input,
      encoding: "utf8",
    })

  it("writes stdin to a file in a directory it makes, and reads it back", () => {
    const at = join(mkdtempSync(join(tmpdir(), "reme-file-")), "src", "a.ts")
    expect(run(FILE_SCRIPTS.write, at, "export {}").status).toBe(0)
    expect(run(FILE_SCRIPTS.read, at).stdout).toBe("export {}")
  })

  it("knows a file, a dangling link and nothing apart", () => {
    const dir = mkdtempSync(join(tmpdir(), "reme-file-"))
    writeFileSync(join(dir, "f"), "")
    symlinkSync(join(dir, "gone"), join(dir, "link"))
    expect(run(FILE_SCRIPTS.exists, join(dir, "f")).status).toBe(0)
    expect(run(FILE_SCRIPTS.exists, join(dir, "link")).status).toBe(0)
    expect(run(FILE_SCRIPTS.exists, join(dir, "none")).status).not.toBe(0)
  })

  it("makes a directory, a tree, and removes a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "reme-file-"))
    expect(run(FILE_SCRIPTS.mkdir, join(dir, "a", "b")).status).not.toBe(0)
    expect(run(FILE_SCRIPTS.mkdirAll, join(dir, "a", "b")).status).toBe(0)
    writeFileSync(join(dir, "f"), "")
    expect(run(FILE_SCRIPTS.remove, join(dir, "f")).status).toBe(0)
    expect(existsSync(join(dir, "f"))).toBe(false)
  })

  it("takes the path as data, never as code", () => {
    const dir = mkdtempSync(join(tmpdir(), "reme-file-"))
    const marker = join(dir, "ran")
    run(FILE_SCRIPTS.read, `$(touch ${marker})`)
    expect(existsSync(marker)).toBe(false)
  })
})

describe("the container's state", () => {
  it("reports stopped until a container runs, for flue's death check", async () => {
    const { sandbox } = newSandbox()
    expect(sandbox.getState()).toEqual({ status: "stopped" })
    await sandbox.exec("true")
    expect(sandbox.getState()).toEqual({ status: "running" })
  })

  it("frees the slot on destroy, twice over", async () => {
    const { sandbox, container } = newSandbox()
    await sandbox.exec("true")
    await sandbox.destroy()
    await sandbox.destroy()
    expect(container.destroyed).toBe(1)
    expect(slots.size).toBe(0)
  })
})

describe("the egress rule", () => {
  const egress = new SandboxEgress({} as never, {} as never)

  it("refuses every host but the registry with 0.12's answer", async () => {
    const refused = await egress.fetch(new Request("https://example.com/"))
    expect(refused.status).toBe(520)
    expect(await refused.text()).toBe("Origin is disallowed")
    const lookalike = await egress.fetch(
      new Request("https://registry.npmjs.org.evil.example/astro")
    )
    expect(lookalike.status).toBe(520)
  })

  it("passes the registry through, with or without a trailing dot", async () => {
    const seen: string[] = []
    vi.stubGlobal("fetch", async (request: Request) => {
      seen.push(request.url)
      return new Response("ok")
    })
    try {
      await egress.fetch(new Request("https://registry.npmjs.org/astro"))
      await egress.fetch(new Request("http://registry.npmjs.org./astro"))
    } finally {
      vi.unstubAllGlobals()
    }
    expect(seen).toEqual([
      "https://registry.npmjs.org/astro",
      "http://registry.npmjs.org./astro",
    ])
  })
})

describe("the pool", () => {
  it("grants five of six sandboxes that start at once and refuses the sixth", async () => {
    const started = Array.from({ length: 6 }, (_, n) =>
      newSandbox(`sandbox-${n}`)
    )
    const opened = await Promise.all(
      started.map(({ sandbox }) => sandbox.open())
    )
    expect(opened.filter(Boolean)).toHaveLength(5)
    expect(opened.filter((o) => !o)).toHaveLength(1)
    // The refused one never started a container.
    expect(started.filter(({ container }) => container.running)).toHaveLength(5)
  })

  it("lets a stopped sandbox's slot go to the next", async () => {
    const started = Array.from({ length: 5 }, (_, n) =>
      newSandbox(`sandbox-${n}`)
    )
    for (const { sandbox } of started) await sandbox.open()
    const late = newSandbox("late")
    expect(await late.sandbox.open()).toBe(false)
    await started[0]?.sandbox.destroy()
    expect(await late.sandbox.open()).toBe(true)
  })

  it("frees a slot whose lease lapsed: a container that slept or crashed", () => {
    vi.useFakeTimers({ now: 0 })
    for (let n = 0; n < 5; n++)
      expect(pool.acquire(`s${n}`, LEASE_MS)).toBe(true)
    expect(pool.acquire("next", LEASE_MS)).toBe(false)
    vi.setSystemTime(LEASE_MS - 1)
    pool.renew("s0", LEASE_MS)
    vi.setSystemTime(LEASE_MS)
    // s1 to s4 lapsed; s0 renewed.
    expect(pool.acquire("next", LEASE_MS)).toBe(true)
    expect([...slots.keys()].sort()).toEqual(["next", "s0"])
  })

  it("counts a sandbox that asks again once", () => {
    for (let n = 0; n < 5; n++) pool.acquire(`s${n}`, LEASE_MS)
    expect(pool.acquire("s0", LEASE_MS)).toBe(true)
    expect(slots.size).toBe(5)
  })
})
