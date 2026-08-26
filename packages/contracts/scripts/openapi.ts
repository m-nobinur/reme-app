import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { contracts } from "../src/registry.ts"

// Zod -> JSON Schema -> OpenAPI. Each contract is emitted self-contained
// (shared pieces inline rather than $ref) so a consumer in any language can
// take one component and validate against it without resolving the document.

export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

export const openapiPath = join(packageRoot, "generated", "openapi.json")

/**
 * The document `generated/openapi.json` must contain. Exported so the suite
 * can assert generation is a fixed point without shelling out.
 */
export function buildOpenApi(): unknown {
  const pkg = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8")
  ) as { version: string }

  const schemas = Object.fromEntries(
    Object.keys(contracts)
      .sort()
      .map((name) => [
        name,
        z.toJSONSchema(contracts[name as keyof typeof contracts], {
          target: "draft-2020-12",
        }),
      ])
  )

  // OpenAPI 3.1 is JSON Schema 2020-12, so the components drop straight in.
  // `paths` is empty on purpose: no service exists yet, and inventing routes
  // here would be guessing at apps/api's shape before it is designed.
  return {
    openapi: "3.1.0",
    info: {
      title: "Reme contracts",
      version: pkg.version,
      description:
        "Every payload that crosses a team boundary. Generated from the Zod schemas in packages/contracts; edit those, not this file.",
    },
    paths: {},
    components: { schemas },
  }
}

/** What the file holds, normalised through JSON so comparisons are honest. */
export function serialiseOpenApi(): string {
  return `${JSON.stringify(buildOpenApi(), null, 2)}\n`
}
