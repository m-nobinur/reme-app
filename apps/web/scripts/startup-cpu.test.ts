import { describe, expect, it } from "vitest"
// @ts-expect-error -- a .mjs script with no types, imported for its pure parts
import { activeMs, startupProblem } from "../../../scripts/startup-cpu.mjs"

const printed = `│ Local startup profile:
│   Profile window: 48.6 ms
│   Active: 12.2 ms (including 0.0 ms garbage collection)
│   Idle: 33.6 ms`
const profile = "/tmp/reme-web-startup-x/worker-startup.cpuprofile"

describe("the startup CPU gate", () => {
  it("reads the Active figure from wrangler's output", () => {
    expect(activeMs(printed)).toBe(12.2)
  })

  it("passes under the ceiling", () => {
    expect(startupProblem(printed, 150, profile)).toBeNull()
  })

  it("fails over the ceiling and names the profile", () => {
    const problem = startupProblem(
      printed.replace("12.2", "151.0"),
      150,
      profile
    )
    expect(problem).toContain("151")
    expect(problem).toContain(profile)
  })

  it.each([
    ["no Active line", "Startup phase analysed"],
    ["an empty output", ""],
    ["a non-numeric figure", "Active: fast ms"],
  ])("fails on %s rather than passing silently", (_, output) => {
    expect(startupProblem(output, 150, profile)).toContain(profile)
  })
})
