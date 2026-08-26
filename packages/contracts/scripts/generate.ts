import { writeFileSync } from "node:fs"
import { openapiPath, serialiseOpenApi } from "./openapi.ts"

writeFileSync(openapiPath, serialiseOpenApi())
