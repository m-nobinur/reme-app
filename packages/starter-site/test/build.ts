import { spawn } from "node:child_process"
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "parse5"
import { fields } from "../src/site-config"

export const ROOT = fileURLToPath(new URL("..", import.meta.url))
/** Reserved by RFC 2606, so nothing built here can name a real site. */
export const ORIGIN = "https://starter.invalid"

export type Built = { dir: string; dist: string }

/**
 * Builds a throwaway copy of the site: the same files the orchestrator seeds
 * (astro.config.mjs, tsconfig.json, src/), with node_modules linked rather
 * than installed, the way the sandbox does it. `site` replaces the config's
 * values, `quoteForm` replaces src/quote-form.json the way the seed writes
 * it from the owner's fact, `pages` plants page files and `remove` deletes
 * them.
 */
export async function build(
  options: {
    site?: Record<string, string>
    quoteForm?: unknown
    pages?: Record<string, string>
    remove?: string[]
  } = {}
): Promise<Built> {
  const dir = mkdtempSync(join(tmpdir(), "reme-starter-"))
  for (const entry of ["astro.config.mjs", "tsconfig.json", "src"]) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true })
  }
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir")
  if (options.site) {
    writeFileSync(
      join(dir, "src/site-config.ts"),
      `export const site = ${JSON.stringify(options.site, null, 2)}\n\n` +
        `export const fields = ${JSON.stringify(fields, null, 2)}\n`
    )
  }
  if (options.quoteForm !== undefined) {
    writeFileSync(
      join(dir, "src/quote-form.json"),
      JSON.stringify(options.quoteForm, null, 2)
    )
  }
  for (const [name, source] of Object.entries(options.pages ?? {})) {
    writeFileSync(join(dir, "src/pages", name), source)
  }
  for (const name of options.remove ?? []) rmSync(join(dir, "src/pages", name))

  const result = await new Promise<{
    code: number | null
    output: string
  }>((resolve) => {
    const child = spawn(
      join(ROOT, "node_modules/.bin/astro"),
      ["build", "--site", ORIGIN],
      { cwd: dir }
    )
    let output = ""
    child.stdout.on("data", (chunk) => {
      output += chunk
    })
    child.stderr.on("data", (chunk) => {
      output += chunk
    })
    child.on("close", (code) => resolve({ code, output }))
  })
  if (result.code !== 0) {
    // A build expected to fail runs every time, so it leaves nothing behind.
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`astro build failed in ${dir}\n${result.output}`)
  }
  return { dir, dist: join(dir, "dist") }
}

export const clean = (built: Built | undefined) => {
  if (built) rmSync(built.dir, { recursive: true, force: true })
}

type Node = {
  nodeName: string
  tagName?: string
  value?: string
  attrs?: { name: string; value: string }[]
  childNodes?: Node[]
}

export type Page = {
  file: string
  html: string
  /** Text a visitor reads, including the title, outside script and style. */
  texts: string[]
  elements: { tag: string; attrs: Record<string, string> }[]
  /** Every script element: its type and its body. */
  scripts: { type: string; body: string }[]
}

/** Every built HTML page under `dist`, parsed with a WHATWG parser. */
export function readPages(dist: string): Page[] {
  return readdirSync(dist, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".html"))
    .sort()
    .map((file) => {
      const html = readFileSync(join(dist, file), "utf8")
      const page: Page = { file, html, texts: [], elements: [], scripts: [] }
      const walk = (node: Node, parent: string) => {
        for (const child of node.childNodes ?? []) {
          if (child.nodeName === "#text") {
            const value = (child.value ?? "").trim()
            if (value && parent !== "script" && parent !== "style") {
              page.texts.push(value)
            }
            continue
          }
          if (!child.tagName) continue
          const attrs = Object.fromEntries(
            (child.attrs ?? []).map((attr) => [attr.name, attr.value])
          )
          page.elements.push({ tag: child.tagName, attrs })
          if (child.tagName === "script") {
            page.scripts.push({
              type: attrs.type ?? "",
              body: (child.childNodes ?? []).map((c) => c.value ?? "").join(""),
            })
          }
          walk(child, child.tagName)
        }
      }
      walk(parse(html) as unknown as Node, "")
      return page
    })
}

/** Every JSON-LD object on a page, top-level items only. */
export const jsonLdOf = (page: Page): Record<string, unknown>[] =>
  page.scripts
    .filter((script) => script.type === "application/ld+json")
    .flatMap((script) => [JSON.parse(script.body)].flat())
