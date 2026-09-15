import { defineConfig } from "astro/config"

// node_modules is a read-only link into the image, so Vite's cache goes
// beside the site instead of inside node_modules/.vite.
export default defineConfig({ vite: { cacheDir: ".vite" } })
