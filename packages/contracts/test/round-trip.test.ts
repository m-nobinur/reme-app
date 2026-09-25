import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { ErrorEnvelope } from "../src/error.ts"
import { EventEnvelope } from "../src/event.ts"
import { contracts } from "../src/registry.ts"
import { ajv, generated } from "./json-schema.ts"
import { samples } from "./samples.ts"

// The property that matters: the Zod schema and the JSON Schema we publish
// mean the same thing. Consumers in other languages only ever see the second
// one, so a divergence between them is a silent cross-boundary bug.

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
    // `parent[last] = value` would set the prototype when the fuzzer picks
    // `__proto__` as a key, producing an object that no JSON document can
    // contain. defineProperty adds the ordinary own key we meant, so
    // `__proto__` gets tested as the adversarial field name it is.
    Object.defineProperty(parent, last, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    })
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
          // Add a field the contract never declared, `__proto__` included:
          // the test below pins that Zod and the JSON Schema agree on it.
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
      // Pinned so a cache hit means something and a red gate is never noise.
      // The cost is a fixed 300 cases: new ground gets covered when the schemas
      // change, not when the clock moves. A random-seed sweep belongs in the
      // nightly job alongside the other non-blocking suites.
      { numRuns: 300, seed: 20260826 }
    )
  })
})

/**
 * `seq` is the position in a session's stream, so it exists exactly when a
 * session does (ADR-028). Zod says that in a `.check()`, which no JSON Schema
 * generator can see, and the published schema says it in an `anyOf` carried as
 * metadata. Two statements of one rule is how they drift, so both are driven
 * from the same cases here.
 */
describe("seq pairs with session_id", () => {
  const event = samples.EventEnvelope as Record<string, unknown>
  const validate = ajv.compile(
    generated.components.schemas.EventEnvelope as object
  )
  const cases: [string, Record<string, unknown>, boolean][] = [
    ["a session event numbers its place", { ...event }, true],
    [
      "an event with no session has no seq",
      { ...event, session_id: null, seq: null },
      true,
    ],
    ["a session with no seq", { ...event, seq: null }, false],
    ["a seq with no session", { ...event, session_id: null }, false],
  ]

  it.each(cases)("%s", (_name, candidate, accepted) => {
    expect(EventEnvelope.safeParse(candidate).success).toBe(accepted)
    expect(validate(candidate)).toBe(accepted)
  })
})

/**
 * `{"__proto__": ...}` is valid JSON, and `JSON.parse` turns it into an
 * ordinary own key rather than touching the prototype. Both the published
 * JSON Schema and Zod refuse it under `additionalProperties: false`.
 *
 * Zod up to 4.4.3 accepted and stripped it instead, which meant a consumer
 * validating against our OpenAPI document rejected a payload our own API waved
 * through. These cases pin the agreement, so the gap cannot reopen unnoticed.
 */
describe("__proto__ as a wire key", () => {
  const wire =
    '{"class":"permission","code":"capability.denied","message":"x","occurred_at":"2026-08-26T09:30:00Z","detail":{},"__proto__":{"polluted":true}}'

  it("arrives as an own key, not a prototype change", () => {
    const data = JSON.parse(wire) as object
    expect(Object.keys(data)).toContain("__proto__")
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype)
  })

  it("is rejected by the published JSON Schema", () => {
    const validate = ajv.compile(
      generated.components.schemas.ErrorEnvelope as object
    )
    expect(validate(JSON.parse(wire))).toBe(false)
  })

  it("is rejected by Zod as well, which closed the gap in 4.6.5", () => {
    // Up to 4.4.3 a strict object accepted the key and stripped it; 4.6.5
    // refuses it outright, so the schema and the parser agree again.
    const result = ErrorEnvelope.safeParse(JSON.parse(wire))
    expect(result.success).toBe(false)
  })

  it("agrees with the JSON Schema on every other inherited key name", () => {
    const validate = ajv.compile(
      generated.components.schemas.ErrorEnvelope as object
    )
    for (const key of Object.getOwnPropertyNames(Object.prototype)) {
      if (key === "__proto__") {
        continue
      }
      const candidate: unknown = JSON.parse(
        wire.replace('"__proto__"', JSON.stringify(key))
      )
      expect(
        ErrorEnvelope.safeParse(candidate).success,
        `zod disagreed with the JSON Schema on "${key}"`
      ).toBe(validate(candidate))
    }
  })
})
