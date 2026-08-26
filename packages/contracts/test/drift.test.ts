import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import { openapiPath, serialiseOpenApi } from "../scripts/openapi.ts"

/**
 * The gate behind B1's "a PR that edits a schema without regenerating fails".
 * It lives in the suite rather than in a CI step so it also fails on the
 * machine of whoever made the edit, before they open the PR.
 *
 * Only `generated/openapi.json` is compared. `generated/openapi.d.ts` is a
 * deterministic function of it produced by a pinned `openapi-typescript`, and
 * hand-edits anywhere under `generated/` are already refused by the
 * pre-commit hook.
 */
it("generated/openapi.json matches the schemas in src", () => {
  // Compare the parsed documents, not the text: the committed file is
  // Biome-formatted, so a string compare would fail on whitespace alone.
  const committed: unknown = JSON.parse(readFileSync(openapiPath, "utf8"))
  const expected: unknown = JSON.parse(serialiseOpenApi())

  expect(
    committed,
    "generated/openapi.json is stale. Run: pnpm --filter @workspace/contracts generate, then commit generated/ with your schema change."
  ).toStrictEqual(expected)
})
