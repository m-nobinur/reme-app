import { describe, expect, it } from "vitest"

/**
 * The sandbox probes, driven against a running orchestrator: `vite dev`
 * with Docker, or staging. Skipped without `ORCHESTRATOR_URL` and
 * `ORCHESTRATOR_TOKEN`, and its floor in scripts/floors.json is what makes a
 * skipped run visible as one. What each case proves is in sandbox.ts.
 */
const url = process.env.ORCHESTRATOR_URL?.replace(/\/$/, "")
const token = process.env.ORCHESTRATOR_TOKEN
const live = describe.skipIf(!url || !token)

type Probe = {
  sandbox_id: string
  cold_start_ms: number
  checks: {
    name: string
    exit_code: number
    duration_ms: number
    output: string
  }[]
}

// This runs seconds after a deploy, and the deploy resets the sandbox's
// Durable Object as it rolls out ("Durable Object reset because its code was
// updated", twice on 2026-09-18, each a 503 mid-probe and a green re-run). So
// a 503 gets two more tries, 20 s apart. A sandbox that is really broken
// answers the same way every time and still fails.
const ATTEMPTS = 3
const WAIT_MS = 20_000

let cached: Promise<Probe> | null = null
const run = () => {
  cached ??= (async () => {
    let res: Response
    for (let attempt = 1; ; attempt++) {
      res = await fetch(`${url}/sandbox/probe`, {
        headers: { authorization: `Bearer ${token}` },
      })
      if (res.status !== 503 || attempt === ATTEMPTS) break
      console.log(`probe answered 503 on attempt ${attempt}, trying again`)
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS))
    }
    if (!res.ok)
      throw new Error(`probe answered ${res.status}: ${await res.text()}`)
    const body = (await res.json()) as Probe
    console.log(JSON.stringify(body, null, 2))
    return body
  })()
  return cached
}

const check = async (name: string) => {
  const probe = await run()
  const found = probe.checks.find((c) => c.name === name)
  if (!found) throw new Error(`no check named ${name}`)
  return found
}

// One probe call serves every case; the first to ask pays the cold start and
// the build, so each case gets the whole budget.
live("the sandbox", { timeout: 300_000 }, () => {
  it("cannot reach the public internet", async () => {
    const egress = await check("egress.denied")
    expect(egress.exit_code).not.toBe(0)
    expect(egress.output).not.toContain("200")
  })

  it("reaches the npm registry", async () => {
    const registry = await check("egress.registry")
    expect(registry.exit_code).toBe(0)
    expect(registry.output).toContain("200")
  })

  it("holds no key, token or connection string", async () => {
    const env = await check("credentials")
    expect(env.exit_code).toBe(0)
    const names = env.output
      .split("\n")
      .map((line) => line.split("=")[0] ?? "")
      .filter(Boolean)
    expect(names.length).toBeGreaterThan(0)
    expect(
      names.filter((n) => /(_KEY|_TOKEN|_SECRET|DATABASE_URL)$/.test(n))
    ).toEqual([])
  })

  it("builds the Astro toolchain check", async () => {
    const build = await check("astro.build")
    expect(build.exit_code).toBe(0)
    expect(build.output).toMatch(/Complete!|built in/)
  })

  it("started cold in a measured time and was destroyed", async () => {
    const probe = await run()
    expect(probe.cold_start_ms).toBeGreaterThan(0)
    expect(probe.sandbox_id).toMatch(/^probe-/)
  })
})
