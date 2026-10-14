import { describe, expect, it } from "vitest"
import { checksOf, runCustomSections } from "../src/tail.ts"

const enc = (s: string) => new TextEncoder().encode(s)

function rig(exit: number, json: string | null) {
  const written: Record<string, string> = {}
  const put = new Map<string, unknown>()
  const commands: string[] = []
  return {
    written,
    put,
    commands,
    run: () =>
      runCustomSections(
        {
          exec: async (command: string) => {
            commands.push(command)
            return { exitCode: exit, stdout: "" }
          },
          readFileBuffer: async () => {
            if (json === null) throw new Error("no such file")
            return enc(json)
          },
          writeFile: async (path: string, content: string) => {
            written[path] = content
          },
        },
        {
          put: async (key: string, value: unknown) => {
            put.set(key, value)
          },
        },
        "sites/o/r/"
      ),
  }
}

describe("runCustomSections", () => {
  it("writes the starter's script into /tmp, runs it and keeps its JSON", async () => {
    const r = rig(
      1,
      '{"findings":[{"file":"f","rule":"tokens","message":"m"}]}'
    )
    expect(await r.run()).toMatchObject({
      exit_code: 1,
      key: "sites/o/r/custom-sections.json",
    })
    expect(r.written["/tmp/custom-sections.mjs"]).toMatch(
      /export function lintSite/
    )
    expect(r.commands[0]).toBe(
      "rm -f /tmp/custom-sections.json; node /tmp/custom-sections.mjs . /tmp/custom-sections.json"
    )
    expect(r.put.has("sites/o/r/custom-sections.json")).toBe(true)
  })

  it("reports a run that left no JSON as failed, even when the shell said 0", async () => {
    expect(await rig(0, null).run()).toMatchObject({ exit_code: 2, key: null })
  })
})

describe("checksOf", () => {
  const ok = { exit_code: 0, output: "", ms: 1 }
  const axe = { exit_code: 0, key: null, ms: 1 }

  it("lists the custom sections check after axe", () => {
    const custom = { exit_code: 1, key: "k", ms: 1 }
    expect(
      checksOf({ check: ok, build: ok, axe: { ...axe, custom } }).at(-1)
    ).toEqual({ check: "custom sections", exit_code: 1, output_key: "k" })
  })

  it("leaves it out when none ran, so the gate fails closed", () => {
    expect(checksOf({ check: ok, build: ok, axe })).toHaveLength(3)
  })
})
