import {
  type CompletionReport,
  DeploymentManifest,
  type FactRecord,
  type GateResult,
} from "@workspace/contracts"
import { claimFindings } from "./claims.ts"
import { type Located, type Page, parsePage } from "./page.ts"
import { resolveSitePath } from "./site-path.ts"
import {
  type ContentClaim,
  type ContentKind,
  contentClaimsIn,
  factsForContent,
  phoneKey,
} from "./text.ts"

export {
  CLAIM_VOCABULARY,
  type ClaimFinding,
  type ClaimKind,
  claimFindings,
  SUPPORTING_FACT_PREFIXES,
} from "./claims.ts"
export { factsToAsk, HIDDEN_FACTS_KEY } from "./fields.ts"
export { type Page, parsePage } from "./page.ts"
export { resolveSitePath } from "./site-path.ts"
export { factsForContent } from "./text.ts"

/**
 * The gates P1 runs outside the sandbox, against the artifact that will be
 * served (§8.5, ADR-032). Pure over contract types: the caller reads R2 and
 * writes evidence; nothing here touches a network, a database or a clock.
 */

const pass = (
  gate: GateResult["gate"],
  message: string | null = null
): GateResult => ({
  gate,
  passed: true,
  evidence_key: null,
  offending_node: null,
  message,
})

const fail = (
  gate: GateResult["gate"],
  message: string,
  node: string | null = null
): GateResult => ({
  gate,
  passed: false,
  evidence_key: null,
  offending_node: node,
  message,
})

const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("")

/** Artifact integrity: every file the manifest lists is there with its hash, and the home page exists. */
export async function checkBuild(
  manifest: unknown,
  read: (file: string) => Promise<Uint8Array | null>
): Promise<GateResult> {
  const parsed = DeploymentManifest.safeParse(manifest)
  if (!parsed.success)
    return fail("build", "the manifest does not parse as a DeploymentManifest")
  const { files } = parsed.data
  if (!Object.hasOwn(files, "index.html"))
    return fail("build", "the build has no index.html")
  for (const [file, expected] of Object.entries(files)) {
    const bytes = await read(file)
    if (!bytes)
      return fail(
        "build",
        `${file} is listed in the manifest and missing from the artifact`,
        file
      )
    const actual = hex(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))
    )
    if (actual !== expected)
      return fail("build", `${file} does not match its manifest hash`, file)
  }
  return pass(
    "build",
    `${Object.keys(files).length} files match their manifest hashes`
  )
}

/** Types, as the build sandbox reported them: a Worker cannot run `astro check` (ADR-032). */
export function checkTypes(
  report: Pick<CompletionReport, "checks">
): GateResult {
  const check = report.checks.find((c) => c.check === "astro check")
  if (!check) return fail("types", "the build sandbox reported no astro check")
  const result =
    check.exit_code === 0
      ? pass("types", "astro check exited 0, as reported by the build sandbox")
      : fail(
          "types",
          `astro check exited ${check.exit_code}, as reported by the build sandbox`
        )
  return { ...result, evidence_key: check.output_key }
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/** Internal links resolve through the manifest; external ones are checked for shape and never fetched. */
export function checkLinks(
  pages: readonly Page[],
  files: Record<string, string>
): GateResult {
  let count = 0
  for (const page of pages) {
    const base = `https://site.invalid/${page.file.replace(/[^/]*$/, "")}`
    for (const link of page.links) {
      const value = link.value.trim()
      if (!value || value.startsWith("#") || /^(mailto|tel):/i.test(value))
        continue
      count++
      const where = `${page.file} ${link.node}`
      if (SCHEME.test(value) || value.startsWith("//")) {
        const url = (() => {
          try {
            return new URL(value.startsWith("//") ? `https:${value}` : value)
          } catch {
            return null
          }
        })()
        if (!url || !["http:", "https:"].includes(url.protocol)) {
          return fail(
            "links",
            `${page.file} links to ${value}, which is not an http or https address`,
            where
          )
        }
        continue
      }
      const pathname = new URL(value, base).pathname
      if (!resolveSitePath(pathname, files)) {
        return fail(
          "links",
          `${page.file} links to ${value}, which the build does not have`,
          where
        )
      }
    }
  }
  return pass("links", `${count} links checked`)
}

/** The schema.org types the starter emits, and the properties each must carry. */
const REQUIRED: Record<string, readonly string[]> = {
  LocalBusiness: ["name"],
  Organization: ["name"],
  Service: ["name"],
  WebSite: ["name"],
  BreadcrumbList: ["itemListElement"],
  FAQPage: ["mainEntity"],
}

/** JSON-LD validated locally: it parses, names schema.org, uses an allowed type and carries that type's required properties. */
export function checkStructuredData(pages: readonly Page[]): GateResult {
  let count = 0
  for (const page of pages) {
    for (const block of page.jsonLd) {
      const where = `${page.file} ${block.node}`
      let data: unknown
      try {
        data = JSON.parse(block.value)
      } catch {
        return fail(
          "structured_data",
          `${page.file} has JSON-LD that does not parse`,
          where
        )
      }
      const root = (data ?? {}) as Record<string, unknown>
      const items = Array.isArray(data)
        ? (data as Record<string, unknown>[])
        : Array.isArray(root["@graph"])
          ? (root["@graph"] as Record<string, unknown>[])
          : [root]
      for (const item of items) {
        count++
        const context = item["@context"] ?? root["@context"]
        if (
          typeof context !== "string" ||
          !/^https?:\/\/schema\.org\/?$/.test(context)
        ) {
          return fail(
            "structured_data",
            `${page.file} has JSON-LD without a schema.org @context`,
            where
          )
        }
        const types = ([] as unknown[]).concat(item["@type"] ?? [])
        if (types.length === 0)
          return fail(
            "structured_data",
            `${page.file} has JSON-LD with no @type`,
            where
          )
        for (const type of types) {
          const required = typeof type === "string" ? REQUIRED[type] : undefined
          if (!required) {
            return fail(
              "structured_data",
              `${page.file} declares @type ${String(type)}, which the starter does not emit`,
              where
            )
          }
          const missing = required.filter(
            (p) => item[p] === undefined || item[p] === "" || item[p] === null
          )
          if (missing.length > 0) {
            return fail(
              "structured_data",
              `${page.file} declares a ${type} without ${missing.join(", ")}`,
              where
            )
          }
        }
      }
    }
  }
  return pass("structured_data", `${count} structured data items valid`)
}

/** Everything a fact's value can support, keyed the way claims are. */
function supported(facts: readonly FactRecord[]): Set<string> {
  const keys = new Set<string>()
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      for (const claim of contentClaimsIn(value))
        keys.add(`${claim.kind}:${claim.key}`)
      const digits = value.replace(/\D/g, "")
      if (/^\+?[\d\s().-]+$/.test(value) && digits.length >= 7)
        keys.add(`phone:${digits}`)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (value && typeof value === "object") {
      const o = value as Record<string, unknown>
      if (
        typeof o.amount_minor === "number" &&
        typeof o.currency === "string"
      ) {
        keys.add(
          `price:${o.currency.toUpperCase()}:${(o.amount_minor / 100).toFixed(2)}`
        )
      }
      for (const item of Object.values(o)) visit(item)
    }
  }
  for (const fact of factsForContent(facts)) visit(fact.value)
  return keys
}

/** JSON-LD properties that carry a business's facts (ADR-032). */
const FACT_BEARING = new Set([
  "telephone",
  "email",
  "address",
  "openingHours",
  "priceRange",
])

function locatedClaims(
  page: Page,
  hosts: readonly string[]
): (ContentClaim & { node: string })[] {
  const found: (ContentClaim & { node: string })[] = []
  const add = (value: string, node: string) =>
    found.push(...contentClaimsIn(value, hosts).map((c) => ({ ...c, node })))
  for (const t of page.texts) add(t.value, t.node)
  for (const l of page.links) {
    const m = l.value.match(/^(mailto|tel):(.*)$/i)
    if (m) add(decodeURIComponent(m[2] ?? ""), l.node)
  }
  for (const block of page.jsonLd) {
    let data: unknown
    try {
      data = JSON.parse(block.value)
    } catch {
      continue
    }
    const visit = (value: unknown, bearing: boolean) => {
      if (typeof value === "string" && bearing) {
        add(value, block.node)
        const key = phoneKey(value)
        if (
          /^\+?[\d\s().-]+$/.test(value) &&
          key &&
          !contentClaimsIn(value).length
        ) {
          found.push({ kind: "phone", text: value, key, node: block.node })
        }
      } else if (Array.isArray(value)) {
        for (const v of value) visit(v, bearing)
      } else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value))
          visit(v, bearing || FACT_BEARING.has(k))
      }
    }
    visit(data, false)
  }
  return found
}

export type ContentFinding = {
  file: string
  node: string
  kind: ContentKind
  claim: string
}

/**
 * Every claim on the built site that no fact supports, with the node it sits
 * in. `hosts` are the site's own host names, whose URLs are not read.
 */
export function contentFindings(
  pages: readonly Page[],
  facts: readonly FactRecord[],
  hosts: readonly string[] = []
): ContentFinding[] {
  const allowed = supported(facts)
  return pages.flatMap((page) =>
    locatedClaims(page, hosts)
      .filter((c) => !allowed.has(`${c.kind}:${c.key}`))
      .map((c) => ({
        file: page.file,
        node: c.node,
        kind: c.kind,
        claim: c.text,
      }))
  )
}

/** The content gate v0: prices, phones, emails, times and postcodes, each traced to a fact (§8.5). */
export function checkContent(
  pages: readonly Page[],
  facts: readonly FactRecord[],
  hosts: readonly string[] = []
): GateResult {
  const findings = contentFindings(pages, facts, hosts)
  const first = findings[0]
  if (!first)
    return pass(
      "content",
      "every price, phone, email, time and postcode traces to a fact"
    )
  return fail(
    "content",
    `${findings.length} claim(s) match no fact; the first is "${first.claim}" (${first.kind}) in ${first.file}`,
    `${first.file} ${first.node}`
  )
}

/** The claims gate v0: every rating, count, superlative, credential, guarantee and testimonial traced to a fact (§8.5). */
export function checkClaims(
  pages: readonly Page[],
  facts: readonly FactRecord[]
): GateResult {
  const findings = claimFindings(pages, facts)
  const first = findings[0]
  if (!first)
    return pass(
      "claims",
      "every rating, count, superlative, credential, guarantee and testimonial traces to a fact"
    )
  return fail(
    "claims",
    `${findings.length} claim(s) match no fact; the first is "${first.claim}" (${first.kind}) in ${first.file}`,
    `${first.file} ${first.node}`
  )
}

/** All six gates over one artifact, in the contract's order. */
export async function runGates(input: {
  manifest: unknown
  read: (file: string) => Promise<Uint8Array | null>
  report: Pick<CompletionReport, "checks">
  facts: readonly FactRecord[]
  /** The site's own host names, as `astro build --site` wrote them. */
  hosts?: readonly string[]
}): Promise<GateResult[]> {
  const build = await checkBuild(input.manifest, input.read)
  const types = checkTypes(input.report)
  const parsed = DeploymentManifest.safeParse(input.manifest)
  if (!parsed.success) {
    const unreadable =
      "the manifest does not parse, so the pages could not be read"
    return [
      build,
      types,
      fail("links", unreadable),
      fail("structured_data", unreadable),
      fail("content", unreadable),
      fail("claims", unreadable),
    ]
  }
  const decoder = new TextDecoder()
  const pages: Page[] = []
  for (const file of Object.keys(parsed.data.files)
    .filter((f) => f.endsWith(".html"))
    .sort()) {
    const bytes = await input.read(file)
    if (bytes) pages.push(parsePage(file, decoder.decode(bytes)))
  }
  return [
    build,
    types,
    checkLinks(pages, parsed.data.files),
    checkStructuredData(pages),
    checkContent(pages, input.facts, input.hosts),
    checkClaims(pages, input.facts),
  ]
}

export type { Located }
