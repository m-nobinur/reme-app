import { join } from "node:path"
import ts from "typescript"
import { ROOT } from "./build"

/** The types the starter may emit, mirrored by the platform's gate. */
export const ALLOWED = [
  "LocalBusiness",
  "Organization",
  "Service",
  "WebSite",
  "BreadcrumbList",
  "FAQPage",
] as const

/**
 * Validates JSON-LD against schema.org with Google's `schema-dts` type
 * declarations, through the TypeScript compiler, offline. Each item becomes
 * `const itemN: WithContext<Type> = <the JSON>`, so a property schema.org does
 * not define on that type, or a value of the wrong kind, is a type error.
 * Returns one line per problem; empty means valid.
 */
export function validateJsonLd(
  items: { where: string; value: Record<string, unknown> }[]
): string[] {
  const problems: string[] = []
  const lines = [
    `import type { WithContext, ${ALLOWED.join(", ")} } from "schema-dts"`,
  ]
  const owners: string[] = []
  items.forEach((item, index) => {
    const type = item.value["@type"]
    if (typeof type !== "string" || !ALLOWED.includes(type as never)) {
      problems.push(`${item.where}: @type ${String(type)} is not allowed`)
      return
    }
    lines.push(
      `export const item${index}: WithContext<${type}> = ${JSON.stringify(item.value)}`
    )
    owners[lines.length - 1] = item.where
  })

  const file = join(ROOT, "test", "__jsonld__.ts")
  const source = `${lines.join("\n")}\n`
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
  }
  const host = ts.createCompilerHost(options)
  const { fileExists, readFile, getSourceFile } = host
  host.fileExists = (name) => name === file || fileExists(name)
  host.readFile = (name) => (name === file ? source : readFile(name))
  host.getSourceFile = (name, language, ...rest) =>
    name === file
      ? ts.createSourceFile(name, source, language)
      : getSourceFile(name, language, ...rest)

  const program = ts.createProgram([file], options, host)
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")
    const line =
      diagnostic.file && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line
        : -1
    problems.push(`${owners[line] ?? "schema-dts"}: ${message}`)
  }
  return problems
}
