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
})
