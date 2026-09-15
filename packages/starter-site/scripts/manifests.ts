/**
 * `node scripts/manifests.ts` (or `pnpm manifests`): the component manifests
 * the Developer reads, kept honest.
 *
 * Every component lives at `src/components/<Name>/<Name>.astro` with a
 * `manifest.yaml` beside it. A manifest whose `source` is `generated` has its
 * `props` written from the component's own `interface Props`, doc comments
 * included, so its prop list cannot drift from the component. A
 * `hand-written` manifest keeps its descriptions, and its prop names, types
 * and required flags are still checked against the component.
 *
 * The run validates every manifest against `ComponentManifest` and writes the
 * array to `manifests.json`, which is committed. The starter's tests load the
 * manifests the same way and fail when the committed file differs, so a
 * manifest changed without this run fails CI. YAML is parsed here and in the
 * tests only; nothing under src/ imports it.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { ComponentManifest } from "@workspace/contracts"
import ts from "typescript"
import { parse, parseDocument } from "yaml"

export const ROOT = fileURLToPath(new URL("..", import.meta.url))
const COMPONENTS = join(ROOT, "src/components")

export type Prop = {
  name: string
  type: string
  required: boolean
  description: string
}
export type Problem = {
  kind: "missing" | "invalid" | "props"
  message: string
}

const walk = (suffix: string) =>
  readdirSync(COMPONENTS, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(suffix))
    .sort((a, b) => a.localeCompare(b))

/** The props a component declares in its frontmatter's `interface Props`. */
export function declaredProps(file: string): Prop[] {
  const source = readFileSync(file, "utf8")
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source)?.[1] ?? ""
  const tree = ts.createSourceFile(
    `${file}.ts`,
    frontmatter,
    ts.ScriptTarget.Latest,
    true
  )
  const props = tree.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === "Props"
  )
  if (!props) return []
  return props.members
    .filter((member): member is ts.PropertySignature =>
      ts.isPropertySignature(member)
    )
    .map((member) => ({
      name: member.name.getText(tree),
      type: member.type?.getText(tree) ?? "unknown",
      required: !member.questionToken,
      description: ts
        .getJSDocCommentsAndTags(member)
        .map((doc) => ts.getTextOfJSDocComment(doc.comment) ?? "")
        .join(" ")
        .trim(),
    }))
}

/** Rewrites the props of every `generated` manifest from its component. */
export function syncGeneratedProps(): string[] {
  const written: string[] = []
  for (const file of walk("manifest.yaml")) {
    const path = join(COMPONENTS, file)
    const text = readFileSync(path, "utf8")
    const doc = parseDocument(text)
    const component = doc.get("path")
    if (doc.get("source") !== "generated" || typeof component !== "string")
      continue
    if (!existsSync(join(ROOT, component))) continue
    doc.set("props", doc.createNode(declaredProps(join(ROOT, component))))
    const next = String(doc)
    if (next !== text) {
      writeFileSync(path, next)
      written.push(file)
    }
  }
  return written
}

/** Every manifest, validated, and every way the set disagrees with the components. */
export function loadManifests(): {
  components: string[]
  manifests: ComponentManifest[]
  problems: Problem[]
} {
  const components = walk(".astro")
  const yamls = walk("manifest.yaml")
  const problems: Problem[] = []
  const manifests: ComponentManifest[] = []

  for (const file of components) {
    const name = basename(file, ".astro")
    if (file !== `${name}/${name}.astro`) {
      problems.push({
        kind: "missing",
        message: `${file} is not in a folder of its own, so it has no manifest`,
      })
    } else if (!yamls.includes(`${name}/manifest.yaml`)) {
      problems.push({
        kind: "missing",
        message: `${file} has no manifest.yaml`,
      })
    }
  }

  for (const file of yamls) {
    const name = dirname(file)
    const parsed = ComponentManifest.safeParse(
      parse(readFileSync(join(COMPONENTS, file), "utf8"))
    )
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
        .join("; ")
      problems.push({ kind: "invalid", message: `${file}: ${issues}` })
      continue
    }
    const manifest = parsed.data
    const expected = `src/components/${name}/${name}.astro`
    if (manifest.component !== name || manifest.path !== expected) {
      problems.push({
        kind: "invalid",
        message: `${file} must name component ${name} at ${expected}`,
      })
      continue
    }
    if (!existsSync(join(ROOT, manifest.path))) {
      problems.push({
        kind: "missing",
        message: `${file} describes ${manifest.path}, which does not exist`,
      })
      continue
    }
    const shape = (prop: Prop) =>
      manifest.source === "generated"
        ? prop
        : { name: prop.name, type: prop.type, required: prop.required }
    const listed = JSON.stringify(manifest.props.map(shape))
    const declared = JSON.stringify(
      declaredProps(join(ROOT, manifest.path)).map(shape)
    )
    if (listed !== declared) {
      problems.push({
        kind: "props",
        message: `${file} lists ${listed} but ${manifest.path} declares ${declared}. Run: pnpm --filter @workspace/starter-site manifests`,
      })
    }
    manifests.push(manifest)
  }
  return { components, manifests, problems }
}

/** One line per component: what the Developer sees before opening a skill. */
export const digest = (manifests: readonly ComponentManifest[]): string =>
  manifests
    .map((manifest) => {
      const props = manifest.props
        .map((p) => `${p.name}${p.required ? "" : "?"}: ${p.type}`)
        .join(", ")
      return `${manifest.component} ${manifest.path} (${props}) forbidden: ${manifest.forbidden.join("; ")}`
    })
    .join("\n")

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const written = syncGeneratedProps()
  for (const file of written)
    console.log(`manifests: props regenerated in ${file}`)
  const { components, manifests, problems } = loadManifests()
  console.log(
    `manifests: ${components.length} components, ${manifests.length} manifests`
  )
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ${problem.message}`)
    process.exit(1)
  }
  writeFileSync(
    join(ROOT, "manifests.json"),
    `${JSON.stringify(manifests, null, 2)}\n`
  )
}
