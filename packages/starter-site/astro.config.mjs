import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { defineConfig } from "astro/config"
import { copyFindings } from "./src/copy-check.ts"

/** Prints the copy check over the built pages. It warns; it never fails a build. */
const copyCheck = {
  name: "copy-check",
  hooks: {
    "astro:build:done": ({ dir, logger }) => {
      const root = fileURLToPath(dir)
      const pages = readdirSync(root, { recursive: true })
        .map(String)
        .filter((file) => file.endsWith(".html"))
        .sort()
        .map((file) => ({ file, html: readFileSync(root + file, "utf8") }))
      const found = copyFindings(pages)
      for (const line of found) logger.warn(line)
      logger.info(
        found.length > 0
          ? `${found.length} finding(s); fix each one in text you wrote`
          : "clean"
      )
    },
  },
}

// node_modules is a read-only link to the sandbox image's toolchain when the
// Developer builds this site, so Vite's cache lives beside the site. See
// infra/sandbox/astro/README.md.
export default defineConfig({
  vite: { cacheDir: ".vite" },
  integrations: [copyCheck],
})
