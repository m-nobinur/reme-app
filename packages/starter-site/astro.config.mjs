import { defineConfig } from "astro/config"

// node_modules is a read-only link to the sandbox image's toolchain when the
// Developer builds this site, so Vite's cache lives beside the site. See
// infra/sandbox/astro/README.md.
export default defineConfig({ vite: { cacheDir: ".vite" } })
