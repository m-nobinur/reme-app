import { defineConfig } from "vitest/config"

// Plain node, not workerd. The routing case builds a `Request` and calls the
// handler, and the tenant-path case talks to Postgres and skips without a
// `DATABASE_URL`. A workerd pool would buy neither and cost a browser-sized
// dependency, so it waits for the first thing that genuinely needs a binding.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
})
