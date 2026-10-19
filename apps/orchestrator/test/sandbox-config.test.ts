import { readdirSync, readFileSync } from "node:fs"
import { URL } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * The sandbox's egress and credential rules, checked on every PR against the
 * source that sets them. The live probes (probe/) prove the same two rules
 * on a running container, but a Durable Object always runs the deployed
 * class, so a PR preview cannot run them against its own code; staging runs
 * them after each deploy. Read as text because the class module binds to
 * the Workers runtime at import.
 */
const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

const SECRET_NAME = /(_KEY|_TOKEN|_SECRET|PASSWORD|DATABASE_URL)\b/

describe("the sandbox egress rule", () => {
  const source = read("src/cloudflare.ts")
  const body =
    /export class RemeSandbox extends Sandbox<Env> \{([\s\S]*?)\n\}/.exec(
      source
    )?.[1] ?? ""

  it("denies the internet and allows the registry and nothing else", () => {
    expect(body).toMatch(/^\s*override enableInternet = false$/m)
    expect(body).toMatch(/^\s*override allowedHosts = \[NPM_REGISTRY_HOST\]$/m)
    expect(read("src/sandbox.ts")).toMatch(
      /export const NPM_REGISTRY_HOST = "registry\.npmjs\.org"$/m
    )
  })
})

describe("the sandbox credential rule", () => {
  it("passes no environment into a container from the Worker", () => {
    const src = readdirSync(new URL("../src/", import.meta.url), {
      recursive: true,
    })
      .filter((f) => String(f).endsWith(".ts"))
      .map((f) => [String(f), read(`src/${f}`)] as const)
    for (const [file, text] of src) {
      expect(text, file).not.toMatch(/\benvVars\b|\bsetEnvVars\b/)
      // `exec` and `startProcess` take an `env` option; none of ours sets one.
      expect(text, file).not.toMatch(
        /\.(exec|startProcess)\([^;]*\{[^;{}]*\benv\s*:/
      )
    }
  })

  it("bakes no secret into the image", () => {
    const names = read("../../infra/sandbox/Dockerfile")
      .split("\n")
      .filter((line) => /^\s*(ENV|ARG)\s/.test(line))
      .map((line) => line.trim().split(/\s+/)[1]?.split("=")[0] ?? "")
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((n) => SECRET_NAME.test(n))).toEqual([])
  })
})
