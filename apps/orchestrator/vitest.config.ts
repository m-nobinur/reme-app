import { defineConfig } from "vitest/config"

// Separate from vite.config.ts on purpose: the Cloudflare plugin refuses to run
// under vitest, and this suite drives Postgres directly rather than workerd.
export default defineConfig({ test: {} })
