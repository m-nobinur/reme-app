import * as v from "valibot"
import { z } from "zod"
import { FacadeError } from "./errors.ts"

/**
 * Flue validates a tool's input with valibot; the repo's contracts are zod.
 * Two schema languages for one shape is drift waiting to happen, so a tool's
 * input is never written in valibot: it is the zod contract (or a pick of
 * it), turned into JSON Schema by zod itself and into valibot here. The
 * subset covered is what the contracts use; anything else fails loudly at
 * module load rather than validating nothing.
 */

type Node = Record<string, unknown>

export type ToolInput<T = unknown> = v.GenericSchema<Record<string, unknown>, T>

/** A zod object schema to the valibot object schema flue mounts, typed by the zod output. */
export function toolInput<T extends z.ZodType>(
  schema: T
): ToolInput<z.output<T>> {
  const json = z.toJSONSchema(schema, { unrepresentable: "any" }) as Node
  const built = convert(json, json)
  if (built.type !== "object" && built.type !== "strict_object") {
    throw new FacadeError(
      "schema.not_object",
      "validation",
      "a tool input must be an object schema"
    )
  }
  return built as ToolInput<z.output<T>>
}

function convert(node: Node, root: Node): v.GenericSchema {
  if (typeof node.$ref === "string") {
    const path = node.$ref.replace(/^#\//, "").split("/")
    let target: unknown = root
    for (const segment of path) target = (target as Node)[segment]
    if (!target) throw unsupported(`unresolved $ref ${node.$ref}`)
    return convert(target as Node, root)
  }
  if (Array.isArray(node.anyOf)) {
    return v.union((node.anyOf as Node[]).map((n) => convert(n, root)))
  }
  if (Array.isArray(node.oneOf)) {
    return v.union((node.oneOf as Node[]).map((n) => convert(n, root)))
  }
  if (Array.isArray(node.enum)) {
    const values = node.enum as unknown[]
    if (values.every((x) => typeof x === "string")) {
      return v.picklist(values as string[])
    }
    return v.union(values.map((x) => v.literal(x as string | number | boolean)))
  }
  if ("const" in node) return v.literal(node.const as string | number | boolean)
  if (Array.isArray(node.type)) {
    return v.union(
      (node.type as string[]).map((t) => convert({ ...node, type: t }, root))
    )
  }
  switch (node.type) {
    case "object":
      return object(node, root)
    case "string":
      return string(node)
    case "integer":
      return number(node, true)
    case "number":
      return number(node, false)
    case "boolean":
      return v.boolean()
    case "null":
      return v.null()
    case "array": {
      const items = node.items ? convert(node.items as Node, root) : v.unknown()
      if (typeof node.minItems === "number") {
        return v.pipe(v.array(items), v.minLength(node.minItems))
      }
      return v.array(items)
    }
    case undefined:
      return v.unknown()
    default:
      throw unsupported(`type ${String(node.type)}`)
  }
}

function object(node: Node, root: Node): v.GenericSchema {
  const properties = (node.properties ?? {}) as Record<string, Node>
  const required = new Set((node.required as string[] | undefined) ?? [])
  const entries: Record<string, v.GenericSchema> = {}
  for (const [name, child] of Object.entries(properties)) {
    const built = convert(child, root)
    entries[name] = required.has(name) ? built : v.optional(built)
  }
  const additional = node.additionalProperties
  if (Object.keys(properties).length === 0) {
    // A map: a record of values, or an open bag.
    const value =
      typeof additional === "object" && additional !== null
        ? convert(additional as Node, root)
        : v.unknown()
    return v.record(v.string(), value)
  }
  return additional === false ? v.strictObject(entries) : v.object(entries)
}

function string(node: Node): v.GenericSchema {
  const checks: v.PipeItem<string, string, v.BaseIssue<unknown>>[] = []
  if (typeof node.minLength === "number")
    checks.push(v.minLength(node.minLength))
  if (typeof node.maxLength === "number")
    checks.push(v.maxLength(node.maxLength))
  if (typeof node.pattern === "string")
    checks.push(v.regex(new RegExp(node.pattern)))
  if (node.format === "uuid") checks.push(v.uuid())
  if (node.format === "date-time") checks.push(v.isoTimestamp())
  return checks.length > 0 ? v.pipe(v.string(), ...checks) : v.string()
}

function number(node: Node, integer: boolean): v.GenericSchema {
  const checks: v.PipeItem<number, number, v.BaseIssue<unknown>>[] = []
  if (integer) checks.push(v.integer())
  if (typeof node.minimum === "number") checks.push(v.minValue(node.minimum))
  if (typeof node.exclusiveMinimum === "number") {
    checks.push(v.gtValue(node.exclusiveMinimum))
  }
  if (typeof node.maximum === "number") checks.push(v.maxValue(node.maximum))
  if (typeof node.exclusiveMaximum === "number") {
    checks.push(v.ltValue(node.exclusiveMaximum))
  }
  return checks.length > 0 ? v.pipe(v.number(), ...checks) : v.number()
}

const unsupported = (what: string) =>
  new FacadeError(
    "schema.unsupported",
    "validation",
    `tool input schema uses ${what}, which the zod to valibot seam does not carry`
  )
