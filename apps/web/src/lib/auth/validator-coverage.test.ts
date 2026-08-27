import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * The tenancy check on request payloads lives in one place, `record()`, on the
 * grounds that every server function's validator calls it. That grounds is a
 * habit until something fails when it is broken: a validator written without
 * `record()` reads its payload unguarded, and nothing about it looks wrong.
 *
 * So discover the validators from the source rather than list them, the way the
 * component catalog and the tenancy suite discover their subjects. A server
 * function added tomorrow is covered without anyone remembering this file.
 */

const SRC = fileURLToPath(new URL("../..", import.meta.url))

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) return sources(path)
    if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith(".test.ts"))
      return []
    return [path]
  })
}

/** The text between `.validator(` and its matching close paren. */
function validatorBodies(source: string): string[] {
  const bodies: string[] = []
  const marker = ".validator("
  let from = source.indexOf(marker)
  while (from !== -1) {
    let depth = 0
    let i = from + marker.length - 1
    for (; i < source.length; i++) {
      if (source[i] === "(") depth++
      else if (source[i] === ")" && --depth === 0) break
    }
    bodies.push(source.slice(from, i + 1))
    from = source.indexOf(marker, i)
  }
  return bodies
}

describe("server function validators", () => {
  const files = sources(SRC)
    .map((path) => ({ path, source: readFileSync(path, "utf8") }))
    .filter(({ source }) => source.includes("createServerFn"))

  it("finds the server functions to check", () => {
    expect(files.length).toBeGreaterThan(0)
    expect(
      files.flatMap(({ source }) => validatorBodies(source)).length
    ).toBeGreaterThan(0)
  })

  for (const { path, source } of files) {
    const name = path.slice(SRC.length)
    for (const [index, body] of validatorBodies(source).entries()) {
      it(`${name} validator ${index + 1} reads its payload through record()`, () => {
        expect(body).toContain("record(")
      })
    }
  }
})
