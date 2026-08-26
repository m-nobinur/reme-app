import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { contracts } from "../src/registry.ts"
import { samples } from "./samples.ts"

// The property that matters: the Zod schema and the JSON Schema we publish
// mean the same thing. Consumers in other languages only ever see the second
// one, so a divergence between them is a silent cross-boundary bug.

const generated = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "generated",
      "openapi.json"
    ),
    "utf8"
  )
) as { components: { schemas: Record<string, object> } }

const ajv = new Ajv2020({ strict: false, allErrors: false })
addFormats(ajv)

type Path = (string | number)[]

/** Every path in a value, the root included. */
function pathsOf(value: unknown, prefix: Path = []): Path[] {
  if (Array.isArray(value)) {
    return [prefix, ...value.flatMap((v, i) => pathsOf(v, [...prefix, i]))]
  }
  if (typeof value === "object" && value !== null) {
    return [
      prefix,
      ...Object.entries(value).flatMap(([k, v]) => pathsOf(v, [...prefix, k])),
    ]
  }
  return [prefix]
}

/** Paths that hold an object, so a fuzzed unknown key has somewhere to land. */
function objectPathsOf(value: unknown): Path[] {
  return pathsOf(value).filter((path) => {
    const node = at(value, path)
    return typeof node === "object" && node !== null && !Array.isArray(node)
  })
}

function at(root: unknown, path: Path): unknown {
  return path.reduce<unknown>(
    (node, key) => (node as Record<string, unknown>)[key],
    root
  )
}

/** Replace the value at `path`, or drop that key when `value` is undefined. */
function mutate(root: unknown, path: Path, value: unknown): unknown {
  if (path.length === 0) {
    return value
  }
  const clone = structuredClone(root)
  const parent = at(clone, path.slice(0, -1)) as Record<string, unknown>
  const last = path[path.length - 1] as string | number
  if (value === undefined) {
    if (Array.isArray(parent)) {
      parent.splice(Number(last), 1)
    } else {
      delete parent[last]
    }
  } else {
    parent[last] = value
  }
  return clone
}

describe.each(Object.keys(contracts))("%s", (name) => {
  const schema = contracts[name as keyof typeof contracts]
  const jsonSchema = generated.components.schemas[name]
  const sample = samples[name as keyof typeof samples]

  it("emits a JSON Schema component", () => {
    expect(jsonSchema).toBeDefined()
  })

  it("accepts its sample under both Zod and the JSON Schema", () => {
    expect(schema.safeParse(sample).success).toBe(true)
    expect(ajv.validate(jsonSchema as object, sample)).toBe(true)
  })

  it("survives a JSON round trip unchanged", () => {
    const parsed = schema.parse(sample)
    const roundTripped: unknown = JSON.parse(JSON.stringify(parsed))
    expect(roundTripped).toStrictEqual(sample)
    expect(schema.safeParse(roundTripped).success).toBe(true)
  })

  it("agrees with the JSON Schema on fuzzed mutations", () => {
    const validate = ajv.compile(jsonSchema as object)
    const paths = pathsOf(sample)
    const objectPaths = objectPathsOf(sample)

    fc.assert(
      fc.property(
        fc.oneof(
          // Replace or drop an existing field.
          fc
            .tuple(
              fc.constantFrom(...paths),
              fc.option(fc.jsonValue(), { nil: undefined })
            )
            .map(([path, value]) => mutate(sample, path, value)),
          // Add a field the contract never declared.
          fc
            .tuple(
              fc.constantFrom(...objectPaths),
              fc.string({ minLength: 1 }),
              fc.jsonValue()
            )
            .map(([path, key, value]) => mutate(sample, [...path, key], value))
        ),
        (candidate) =>
          schema.safeParse(candidate).success === validate(candidate)
      ),
      { numRuns: 300 }
    )
  })
})
