import { defineConfig } from "vitest/config"

// Separate from vite.config.ts on purpose: the Cloudflare plugin refuses to run
// under vitest, and this suite drives Postgres directly rather than workerd.
// Vitest empties CSS it does not include, `?raw` imports too; the seed bundles
// the starter site's stylesheets as text, so the seed test needs them whole.
export default defineConfig({
  test: {
    // Three locally, so targeted runs from several agents leave the Mac usable.
    maxWorkers: process.env.CI ? undefined : 3,
    css: { include: [/packages\/starter-site\//] },
    globalSetup: ["../../packages/db/fixtures/reap.ts"],
  },
})
