import { execFileSync } from "node:child_process"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { SITE_ROOT } from "../src/revise.ts"
import { finishRevision, runAxe, uploadDist } from "../src/tail.ts"

const enc = (s: string) => new TextEncoder().encode(s)
const sha = async (s: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", enc(s))),
    (b) => b.toString(16).padStart(2, "0")
  ).join("")

/** A sandbox holding `dist/`, a bucket holding the previous revision's files. */
async function rig(
  now: Record<string, string>,
  before: Record<string, string>,
  options: { sumsFail?: boolean; hide?: string[]; swept?: boolean } = {}
) {
  const read: string[] = []
  const copied: string[] = []
  const stored = new Map<string, string>()
  const bucket = new Map(
    Object.entries(options.swept ? {} : before).map(([f, body]) => [
      `old/dist/${f}`,
      body,
    ])
  )
  let inFlight = 0
  let peak = 0
  const sandbox = {
    exec: async (command: string) => {
      if (command.includes("sha256sum")) {
        if (options.sumsFail) return { exitCode: 1, stdout: "" }
        const lines = await Promise.all(
          Object.entries(now)
            .filter(([f]) => !options.hide?.includes(f))
            .map(async ([f, body]) => `${await sha(body)}  dist/${f}`)
        )
        return { exitCode: 0, stdout: lines.join("\n") }
      }
      return {
        exitCode: 0,
        stdout: Object.keys(now)
          .sort()
          .map((f) => `dist/${f}`)
          .join("\n"),
      }
    },
    readFileBuffer: async (path: string) => {
      peak = Math.max(peak, ++inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
      const file = path.replace("/workspace/site/dist/", "")
      read.push(file)
      return enc(now[file] ?? "")
    },
  }
  const sites = {
    get: async (key: string) => {
      const body = bucket.get(key)
      if (body === undefined) return null
      copied.push(key.replace("old/dist/", ""))
      return { arrayBuffer: async () => enc(body).buffer as ArrayBuffer }
    },
    put: async (key: string, value: Uint8Array | ArrayBuffer) => {
      stored.set(key, new TextDecoder().decode(value))
    },
  }
  const previous = {
    base: "old/",
    files: Object.fromEntries(
      await Promise.all(
        Object.entries(before).map(async ([f, b]) => [f, await sha(b)])
      )
    ),
  }
  const run = () => uploadDist({ sandbox, sites, prefix: "new/", previous })
  return { run, read, copied, stored, peak: () => peak }
}

describe("the dist upload", () => {
  it("reads only the changed files out of the sandbox and copies the rest inside R2", async () => {
    const r = await rig(
      { "index.html": "new home", "a.css": "same", "b.js": "same too" },
      { "index.html": "old home", "a.css": "same", "b.js": "same too" }
    )
    const out = await r.run()
    expect(r.read).toEqual(["index.html"])
    expect([...r.copied].sort()).toEqual(["a.css", "b.js"])
    expect(Object.fromEntries(r.stored)).toEqual({
      "new/dist/index.html": "new home",
      "new/dist/a.css": "same",
      "new/dist/b.js": "same too",
    })
    expect(out).toMatchObject({ sent: 1, reused: 2 })
    expect(out.files).toEqual({
      "a.css": await sha("same"),
      "b.js": await sha("same too"),
      "index.html": await sha("new home"),
    })
    expect(out.routes).toEqual([{ path: "/", file: "index.html" }])
  })

  it("reads a file out of the sandbox when the earlier copy is gone", async () => {
    // Retention swept the earlier revision's files after its manifest was read.
    const r = await rig(
      { "index.html": "home" },
      { "index.html": "home" },
      { swept: true }
    )
    const out = await r.run()
    expect(r.read).toEqual(["index.html"])
    expect(out).toMatchObject({ sent: 1, reused: 0 })
  })

  it("hashes in the worker what sha256sum did not report, and when it failed altogether", async () => {
    const missing = await rig(
      { "index.html": "home", "odd name.css": "x" },
      {},
      { hide: ["odd name.css"] }
    )
    expect((await missing.run()).files["odd name.css"]).toBe(await sha("x"))
    const failed = await rig(
      { "index.html": "home" },
      { "index.html": "home" },
      { sumsFail: true }
    )
    const out = await failed.run()
    expect(out).toMatchObject({ sent: 1, reused: 0 })
    expect(out.files["index.html"]).toBe(await sha("home"))
  })

  it("uploads at most eight at a time", async () => {
    const now = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`img/${i}.png`, `image ${i}`])
    )
    const r = await rig({ "index.html": "home", ...now }, {})
    const out = await r.run()
    expect(out.sent).toBe(31)
    expect(r.peak()).toBe(8)
  })
})

describe("the axe step", () => {
  const axeRig = (exitCode: number, json: string | null) => {
    const put = new Map<string, Uint8Array>()
    const commands: string[] = []
    return {
      put,
      commands,
      run: () =>
        runAxe(
          {
            exec: async (command) => {
              commands.push(command)
              return { exitCode }
            },
            readFileBuffer: async () => {
              if (json === null) throw new Error("no such file")
              return enc(json)
            },
          },
          { put: async (key, value) => void put.set(key, value as Uint8Array) },
          "sites/o/r/"
        ),
    }
  }

  it("keeps the JSON as evidence and reports the script's own exit code", async () => {
    for (const code of [0, 1]) {
      const r = axeRig(code, '{"pages":[]}')
      expect(await r.run()).toMatchObject({
        exit_code: code,
        key: "sites/o/r/axe.json",
      })
      expect(new TextDecoder().decode(r.put.get("sites/o/r/axe.json"))).toBe(
        '{"pages":[]}'
      )
      expect(r.commands[0]).toMatch(
        /^rm -f \/tmp\/axe.json; node \/opt\/astro\/axe.mjs dist/
      )
    }
  })

  // A scroll reveal caught mid-fade reads as low contrast. The script is the
  // sandbox image's, so its source is what can be checked here: it scans with
  // reduced motion and waits for clock-driven animations first.
  it("scans with reduced motion and after animations finish", () => {
    const script = readFileSync(
      new URL("../../../infra/sandbox/astro/axe.mjs", import.meta.url),
      "utf8"
    )
    expect(script).toMatch(/reducedMotion:\s*"reduce"/)
    expect(script.indexOf("getAnimations()")).toBeGreaterThan(
      script.indexOf("page.goto")
    )
    expect(script.indexOf("getAnimations()")).toBeLessThan(
      script.indexOf("new AxeBuilder")
    )
  })

  it("reports a run that left no JSON as failed, even when the shell said 0", async () => {
    expect(await axeRig(0, null).run()).toMatchObject({
      exit_code: 2,
      key: null,
    })
    expect(await axeRig(137, null).run()).toMatchObject({
      exit_code: 137,
      key: null,
    })
  })
})

describe("the build at the end of a report", () => {
  /**
   * `finishRevision`'s own shell commands, run by bash in a scratch site
   * whose `astro` exits and writes as the case says. The steps after the
   * build are not reached here: the first one stops the run.
   */
  const finish = async (build: string) => {
    const site = mkdtempSync(join(tmpdir(), "reme-tail-"))
    mkdirSync(join(site, "node_modules/.bin"), { recursive: true })
    const astro = join(site, "node_modules/.bin/astro")
    writeFileSync(
      astro,
      `#!/bin/sh\necho "astro $1"\n[ "$1" = check ] && exit 0\n${build}\n`
    )
    chmodSync(astro, 0o755)
    const local = (path: string) => path.replaceAll(SITE_ROOT, site)
    const ran: string[] = []
    const sandbox = {
      exec: async (command: string) => {
        try {
          const stdout = execFileSync("bash", ["-c", local(command)], {
            encoding: "utf8",
          })
          return { exitCode: 0, stdout, stderr: "" }
        } catch (error) {
          const failed = error as { status: number; stdout: string }
          return { exitCode: failed.status, stdout: failed.stdout, stderr: "" }
        }
      },
      readFileBuffer: async () => new Uint8Array(),
      writeFile: async (path: string, content: string) => {
        mkdirSync(dirname(local(path)), { recursive: true })
        writeFileSync(local(path), content)
      },
    }
    const db = {
      select: () => ({
        from: () => ({ where: async () => [{ slug: "acme" }] }),
      }),
    }
    const outcome = finishRevision({
      steps: {
        do: async (name: string, fn: () => Promise<unknown>) => {
          ran.push(name)
          if (name === "revision") throw new Error("reached the revision")
          return fn()
        },
      },
      sandbox,
      kit: { withOrg: (_: unknown, fn: (d: unknown) => unknown) => fn(db) },
      sites: {},
      hostSuffix: "-stg.remeai.co.uk",
      orgId: "o",
      assignmentId: "a",
      facts: [],
    } as unknown as Parameters<typeof finishRevision>[0])
    return { outcome, ran }
  }

  it("fails the report when astro build fails, whatever its output's tail says", async () => {
    const { outcome, ran } = await finish('echo "ENOENT: font cache"; exit 1')
    await expect(outcome).rejects.toThrow(/astro build failed[\s\S]*ENOENT/)
    expect(ran).not.toContain("revision")
  })

  it("fails the report when astro build exits 0 and writes no page", async () => {
    const { outcome, ran } = await finish("mkdir -p dist/_astro; exit 0")
    await expect(outcome).rejects.toThrow(/wrote no pages/)
    expect(ran).not.toContain("revision")
  })

  it("goes on to the revision when the build wrote its pages", async () => {
    const { outcome } = await finish(
      "mkdir -p dist && echo '<html></html>' > dist/index.html"
    )
    await expect(outcome).rejects.toThrow("reached the revision")
  })
})
