import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Three locally, so targeted runs from several agents leave the Mac usable.
    maxWorkers: process.env.CI ? undefined : 3,
    globalSetup: ["./test/builds.ts"],
  },
})
