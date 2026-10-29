import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// Deliberately not extending vite.config.ts: that one loads the Cloudflare
// plugin to build the Worker, which unit tests neither need nor can run under.
// The `@` alias is the app's own, so a test can load a wired module as is.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    // Rendering tests run ~10x slower in the gate's 4-CPU act container
    // beside three other suites; the 5 s default timed out a 95 ms test there.
    testTimeout: 15_000,
    // Re-importing React and the rest for every file was most of the run.
    isolate: false,
    setupFiles: ["./src/fresh-modules.ts"],
  },
})
