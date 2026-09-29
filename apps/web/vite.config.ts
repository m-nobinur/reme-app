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
  resolve: { tsconfigPaths: true },
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
