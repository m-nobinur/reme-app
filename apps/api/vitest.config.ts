import { readFileSync } from "node:fs"
import { defineConfig } from "vitest/config"

// Plain node, not workerd. The routing case builds a `Request` and calls the
// handler, and the tenant-path case talks to Postgres and skips without a
// `DATABASE_URL`. A workerd pool would buy neither and cost a browser-sized
// dependency, so it waits for the first thing that genuinely needs a binding.
//
// No `include`: the two directories are chosen with `--dir`, the way
// `packages/db` does it. `test/` runs as `pnpm test`, and `tenancy/` runs as
// `pnpm test:tenancy` after `packages/db`'s, so cross-org denial through the
// authenticated API sits inside the blocking gate rather than beside it. An
// `include` written from the package root would be resolved against `--dir` and
// match nothing.
//
// A `.webp` imports as its bytes, as wrangler's `Data` rule makes it in the
// Worker (`logo-references.ts`); vite would hand back a URL.
const webpAsBytes = {
  name: "webp-as-bytes",
  enforce: "pre" as const,
  load(id: string) {
    if (!id.endsWith(".webp")) return null
    const base64 = readFileSync(id).toString("base64")
    return `export default Uint8Array.from(atob("${base64}"), (c) => c.charCodeAt(0)).buffer`
  },
}

export default defineConfig({ plugins: [webpAsBytes], test: {} })
