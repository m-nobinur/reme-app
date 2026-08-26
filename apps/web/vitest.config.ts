import { defineConfig } from "vitest/config"

// Deliberately not extending vite.config.ts: that one loads the Cloudflare
// plugin to build the Worker, which unit tests neither need nor can run under.
export default defineConfig({
  test: { include: ["src/**/*.test.ts", "scripts/**/*.test.ts"] },
})
