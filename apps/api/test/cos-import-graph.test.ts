import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { describe, expect, it } from "vitest"

/**
 * Every api module the Chief of Staff's code can reach, walked from
 * `src/cos/` through relative imports, and none of them names
 * `conversationMessages` (ADR-034). The Biome rule only sees a file's own
 * imports; this sees what those imports pull in.
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url))
const COS = join(SRC, "cos")

/** The relative module specifiers `file` imports, re-exports or loads. */
function specifiers(source: ts.SourceFile): string[] {
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text)
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      found.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found.filter((s) => s.startsWith("."))
}

/** Whether `source` has an identifier named `conversationMessages` anywhere. */
function names(source: ts.SourceFile): boolean {
  let hit = false
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === "conversationMessages") {
      hit = true
    }
    if (!hit) ts.forEachChild(node, visit)
  }
  visit(source)
  return hit
}

/** Each reachable module, from `cos/`, with the path that reached it. */
function reachable(): Map<string, string[]> {
  const seen = new Map<string, string[]>()
  const queue: [string, string[]][] = readdirSync(COS)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => [join(COS, f), []])
  while (queue.length > 0) {
    const [file, via] = queue.shift() as [string, string[]]
    if (seen.has(file)) continue
    const path = [...via, relative(SRC, file)]
    seen.set(file, path)
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest
    )
    for (const spec of specifiers(source)) {
      const target = resolve(dirname(file), spec)
      queue.push([target.endsWith(".ts") ? target : `${target}.ts`, path])
    }
  }
  return seen
}

describe("what cos/ can reach", () => {
  it("never names conversationMessages", () => {
    const offending = [...reachable()]
      .filter(([file]) =>
        names(
          ts.createSourceFile(
            file,
            readFileSync(file, "utf8"),
            ts.ScriptTarget.Latest
          )
        )
      )
      .map(([, path]) => path.join(" -> "))
    expect(offending).toEqual([])
  })

  it("walks past cos/ itself, so an empty result is not an empty walk", () => {
    const files = [...reachable().keys()].map((f) => relative(SRC, f))
    expect(files).toContain("http.ts")
    expect(files).toContain("workspace.ts")
  })
})
