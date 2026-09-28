import { cloudflare } from "@cloudflare/vite-plugin"
import { flue, flueWorkerConfig } from "@flue/vite"
import { defineConfig } from "vite"

/**
 * The one file outside `packages/facade` allowed to import `@flue/*`, and only
 * because the build needs it: `flue()` scans for `'use agent'` modules and
 * generates a Durable Object per agent, and `flueWorkerConfig()` merges those
 * bindings and the entry into `wrangler.jsonc` for the Cloudflare plugin.
 * Order matters and flue's docs say so: `flue()` first.
 */
export default defineConfig({
  tsconfig: "./tsconfig.json",
  plugins: [flue(), cloudflare({ config: flueWorkerConfig() })],
  // Minified here, not in `wrangler.jsonc`: the built config is `no_bundle`,
  // so wrangler's `minify` would do nothing. Measured with `pnpm size`:
  // 1647.78 KiB gzip (8949.91 raw) before, 915.90 (4311.17) after. Rolldown
  // drops names by default, which renamed `PostgresError`; `postgres` copies
  // `this.constructor.name` into `error.name` and `failureCode` logs it, so
  // `keepNames` is on. `sourcemap` makes the Cloudflare plugin write
  // `upload_source_maps` into the built config, so stack traces in Workers
  // Logs map back to `src/`.
  build: {
    minify: true,
    sourcemap: true,
    rolldownOptions: { output: { keepNames: true } },
  },
})
