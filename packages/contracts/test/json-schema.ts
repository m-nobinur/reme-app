import { readFileSync } from "node:fs"
import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"
import { openapiPath } from "../scripts/openapi.ts"

/** The committed document, as a consumer in another language reads it. */
export const generated = JSON.parse(readFileSync(openapiPath, "utf8")) as {
  components: { schemas: Record<string, object> }
}

export const ajv = new Ajv2020({ strict: false, allErrors: false })
addFormats(ajv)

type Verdict = { zod: boolean; json: boolean }

/** Whether Zod and the published JSON Schema each accept `value`. */
export const verdict = (
  name: string,
  schema: { safeParse: (v: unknown) => { success: boolean } },
  value: unknown
): Verdict => ({
  zod: schema.safeParse(value).success,
  json: ajv.validate(generated.components.schemas[name] as object, value),
})
export const ACCEPTED: Verdict = { zod: true, json: true }
export const REFUSED: Verdict = { zod: false, json: false }
