import { readdirSync, readFileSync, rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { defineConfig, fontProviders } from "astro/config"
import { copyFindings } from "./src/copy-check.ts"
import { familiesOf, pairOf } from "./src/fonts.ts"
import { iconFindings } from "./src/icons.ts"
import { site } from "./src/site-config.ts"

/** Prints the copy check over the built pages, and any icon the config names that src/icons.ts lacks. It warns; it never fails a build. */
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
      const found = [...iconFindings(site), ...copyFindings(pages)]
      for (const line of found) logger.warn(line)
      logger.info(
        found.length > 0
          ? `${found.length} finding(s); fix each one in text you wrote`
          : "clean"
      )
    },
  },
}

/**
 * Astro emits the original of every image a page imports beside its resized
 * variants, and a page names only the variants. Drops each image under
 * _astro/ that no page or stylesheet mentions: a 2 MB generated PNG was 88%
 * of a revision's dist.
 */
const dropOriginals = {
  name: "drop-originals",
  hooks: {
    "astro:build:done": ({ dir }) => {
      const root = fileURLToPath(dir)
      const files = readdirSync(root, { recursive: true }).map(String)
      const text = files
        .filter((file) => /\.(html|css|js|json|xml)$/.test(file))
        .map((file) => readFileSync(root + file, "utf8"))
        .join("\n")
      for (const file of files) {
        const name = file.slice(file.lastIndexOf("/") + 1)
        if (
          file.startsWith("_astro/") &&
          /\.(png|jpe?g|webp|avif|gif)$/.test(name) &&
          !text.includes(name)
        ) {
          rmSync(root + file)
        }
      }
    },
  },
}

// node_modules is a read-only link to the sandbox image's toolchain when the
// Developer builds this site, so Vite's cache and Astro's (fonts and resized
// images, `node_modules/.astro` by default) live beside the site. See
// infra/sandbox/astro/README.md.
//
// The fonts are the chosen pair's @fontsource files and nothing else, read
// from the image's node_modules: two to four woff2 files, or none when the
// site has no pair.
const provider = fontProviders.local()

export default defineConfig({
  cacheDir: "./.astro-cache",
  vite: { cacheDir: ".vite" },
  fonts: familiesOf(pairOf(site.font)).map((family) => ({
    provider,
    ...family,
  })),
  integrations: [dropOriginals, copyCheck],
})
