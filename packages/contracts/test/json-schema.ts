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
