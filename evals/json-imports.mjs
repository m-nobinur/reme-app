import { readFile } from "node:fs/promises"
import { register } from "node:module"
import { fileURLToPath } from "node:url"
import { isMainThread } from "node:worker_threads"

/**
 * Lets the api's `import x from "./y.json"` load under bare node, as the
 * bundler does, for scripts that import the api's source:
 *
 *   node --import ./evals/json-imports.mjs --experimental-transform-types <script>
 */
if (isMainThread) register(import.meta.url)

export async function load(url, context, nextLoad) {
  if (url.endsWith(".json") && !context.importAttributes?.type) {
    const source = await readFile(fileURLToPath(url), "utf8")
    return { format: "json", source, shortCircuit: true }
  }
  return nextLoad(url, context)
}
