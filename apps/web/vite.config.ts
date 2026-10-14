import { readFileSync } from "node:fs"
import { cloudflare } from "@cloudflare/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { micromark } from "micromark"
import { gfm, gfmHtml } from "micromark-extension-gfm"
import { defineConfig, type Plugin } from "vite"

/**
 * `import html from "./page.md?html"`: the Markdown becomes an HTML string at
 * build time, so no parser ships in the Worker. Only for our own content.
 */
const markdownHtml: Plugin = {
  name: "markdown-html",
  load(id) {
    if (!id.endsWith(".md?html")) return
    const markdown = readFileSync(id.slice(0, -"?html".length), "utf8")
    const html = micromark(markdown, {
      extensions: [gfm()],
      htmlExtensions: [gfmHtml()],
    })
    return `export default ${JSON.stringify(html)}`
  },
}

const config = defineConfig({
  resolve: {
    tsconfigPaths: true,
    // pnpm installs @assistant-ui/react twice, once per `ai` peer (zod 3 for
    // packages/ui, zod 4 for the app), and each copy brings its own core. A
    // history adapter provided through one is invisible to the runtime built
    // from the other, so a reloaded conversation opened empty.
    dedupe: [
      "@assistant-ui/react",
      "@assistant-ui/core",
      "@assistant-ui/store",
      "@assistant-ui/tap",
    ],
  },
  plugins: [
    // First: merges the Worker config into the framework's SSR build, so dev,
    // preview and production all run on workerd.
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
    markdownHtml,
  ],
})

export default config
