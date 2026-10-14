import { describe, expect, it } from "vitest"
import { uploadDist } from "../src/tail.ts"

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
