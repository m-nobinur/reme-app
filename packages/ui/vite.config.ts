import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Serves the component catalog and nothing else. `packages/ui` ships as source
// and is bundled by whatever imports it, so this config has no build target.
// The alias is the runtime half of the `@workspace/ui/*` mapping that
// tsconfig.json already gives the type checker; there is no self-link in
// node_modules for a package to resolve its own name through.
export default defineConfig({
  plugins: [tailwindcss(), viteReact()],
  resolve: {
    alias: {
      "@workspace/ui": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: { port: 4321 },
})
