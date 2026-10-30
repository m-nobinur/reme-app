import {
  type Blueprint,
  type CompletionReport,
  DeploymentManifest,
  type FactRecord,
  type GateResult,
} from "@workspace/contracts"
import { checkAxe, parseAxe } from "./axe.ts"
import { claimFindings, generatedImageFindings } from "./claims.ts"
import { checkCopy } from "./copy.ts"
import {
  CUSTOM_CHECK,
  checkCustomSections,
  parseCustom,
  withCustomSections,
} from "./custom.ts"
import { type Located, type Page, parsePage } from "./page.ts"
import { limit } from "./pool.ts"
import { resolveSitePath } from "./site-path.ts"
import { checkSize, type SizeBudget } from "./size.ts"
import {
  type ContentClaim,
  type ContentKind,
  contentClaimsIn,
  factsForContent,
  phoneKey,
} from "./text.ts"

export { type AxeResult, checkAxe, parseAxe } from "./axe.ts"
export {
  CLAIM_IMAGE_SECTIONS,
  CLAIM_VOCABULARY,
  type ClaimFinding,
  type ClaimKind,
  claimFindings,
  generatedImageFindings,
  SUPPORTING_FACT_PREFIXES,
} from "./claims.ts"
export {
  COPY_WORDS,
  type CopyFinding,
  type CopyKind,
  checkCopy,
  copyFindings,
  copyGateRules,
  DESCRIPTION_CHARS,
  factWords,
  fieldFindings,
  NEAR as HEADING_NEAR,
  STOCK_HEADINGS,
  TITLE_CHARS,
} from "./copy.ts"
export {
  CUSTOM_CHECK,
  type CustomFinding,
  checkCustomSections,
  parseCustom,
  withCustomSections,
} from "./custom.ts"
export { factsToAsk, HIDDEN_FACTS_KEY } from "./fields.ts"
export {
  checkInteraction,
  type InteractionFinding,
  type InteractionResult,
  parseInteraction,
} from "./interaction.ts"
export { type Page, parsePage } from "./page.ts"
export { limit } from "./pool.ts"
export { resolveSitePath } from "./site-path.ts"
export { checkSize, type SizeBudget } from "./size.ts"
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
  // Every file is read at once (the caller bounds the reads) and the first
  // failure in manifest order is the one reported, as when they ran in turn.
  const checked = await Promise.all(
    Object.entries(files).map(async ([file, expected]) => {
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
      return actual === expected
        ? null
        : fail("build", `${file} does not match its manifest hash`, file)
    })
  )
  const failed = checked.find((result) => result !== null)
  if (failed) return failed
  return pass(
    "build",
    `${Object.keys(files).length} files match their manifest hashes`
  )
}

const pageSlug = (page: string) =>
  page === "home"
    ? "index"
    : page === "service"
      ? "services/[slug]"
      : page.replaceAll("_", "-")

/**
 * The approved Blueprint's pages are fixed: each is in the build, at the path
 * its starter file serves (`service_area` is `service-area/`), so a lead that
 * deletes one fails the build gate and repairs it. Null when none is missing.
 */
export function checkPlannedPages(
  plan: Pick<Blueprint, "pages">,
  files: Record<string, string>
): GateResult | null {
  const slug = pageSlug
  // `service` is one page per service under services/; the services page's
  // links to each are the links gate's to check.
  const servicePages = Object.keys(files).filter((f) =>
    /^services\/[^/]+\/index\.html$/.test(f)
  ).length
  const missing = plan.pages
    .map(({ page }) => page)
    .filter((page) =>
      page === "service"
        ? servicePages === 0
        : !resolveSitePath(page === "home" ? "/" : `/${slug(page)}/`, files)
    )
  const [first] = missing
  if (!first) return null
  return fail(
    "build",
    `the Blueprint plans ${missing.join(", ")} and the build has no page for ${missing.length > 1 ? "them" : "it"}: restore ${missing.map((page) => `src/pages/${slug(page)}.astro`).join(", ")}${missing.includes("service") ? " (it builds a page for each service with a name)" : ""}. Every planned page stays, whatever the facts`,
    first
  )
}

/**
 * A planned gallery is on its page: the owner picked it and the plan holds it,
 * so a build that draws nothing (its photo paths or alt text unset) fails and
 * the repair sets them. Other planned sections can render empty by design (a
 * review section without reviews), so only the gallery, which exists only
 * with the owner's photos, is checked. Null when none is missing.
 */
export function checkPlannedSections(
  plan: Pick<Blueprint, "pages">,
  built: readonly { file: string; html: string }[]
): GateResult | null {
  const drawn = (page: string) => {
    const file = page === "home" ? "index.html" : `${pageSlug(page)}/index.html`
    const html = built.find((b) => b.file === file)?.html ?? ""
    return /<section\b[^>]*\bclass="(?:[^"]*\s)?gallery[\s"]/.test(html)
  }
  const first = plan.pages.find(
    ({ page, sections }) =>
      page !== "service" &&
      sections.some((s) => s.kind === "gallery") &&
      !drawn(page)
  )
  if (!first) return null
  return fail(
    "build",
    `the Blueprint plans a gallery on ${first.page} and the build shows none: it renders only when site.photo1Src to site.photo3Src name the owner's photos and photo1Alt to photo3Alt say what each shows. Set them in src/site-config.ts and keep the gallery section on the page`,
    first.page
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

/**
 * The schema.org types the starter emits, and the properties each must carry.
 * The platform builds with `--site`, so the starter always writes `url`: one
 * missing was deleted, not left out, and costs the site its search listing.
 */
const REQUIRED: Record<string, readonly string[]> = {
  LocalBusiness: ["name", "url"],
  Organization: ["name"],
  Service: ["name", "url"],
  WebSite: ["name", "url"],
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
  facts: readonly FactRecord[],
  plan?: Parameters<typeof generatedImageFindings>[0]
): GateResult {
  const findings = [
    ...claimFindings(pages, facts),
    ...(plan ? generatedImageFindings(plan) : []),
  ]
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

/** Reads in flight at once against the artifact store. */
const READS = 8

/**
 * All nine gates over one artifact, in the contract's order. Each file is
 * read once: the build gate hashes every file while the pages are read for
 * the other gates, and a page both need comes from the same read.
 */
export async function runGates(input: {
  manifest: unknown
  read: (file: string) => Promise<Uint8Array | null>
  report: Pick<CompletionReport, "checks">
  facts: readonly FactRecord[]
  /** The site's own host names, as `astro build --site` wrote them. */
  hosts?: readonly string[]
  /** `size-budget.json`: the home page's gzip line; fonts and images have their own. */
  budget: SizeBudget
  /** Reads the sandbox's evidence by the key its check reported (the axe JSON). */
  evidence?: (key: string) => Promise<Uint8Array | null>
  /** Filled with milliseconds per gate, and `read` for the page reads. */
  timings?: Record<string, number>
  /**
   * The Blueprint's image slots and pages, so a generated photo in a claim
   * section fails (ADR-039), and so does a planned page the build lacks. The
   * copy gate runs only with it.
   */
  plan?: Parameters<typeof generatedImageFindings>[0]
}): Promise<GateResult[]> {
  const lap = <T>(name: string, fn: () => T): T => {
    const started = Date.now()
    const out = fn()
    if (input.timings) input.timings[name] = Date.now() - started
    return out
  }
  const bounded = limit(READS)
  const reads = new Map<string, Promise<Uint8Array | null>>()
  const read = (file: string) => {
    let once = reads.get(file)
    if (!once) {
      once = bounded(() => input.read(file))
      reads.set(file, once)
    }
    return once
  }
  const customKey = input.report.checks.find(
    (c) => c.check === CUSTOM_CHECK
  )?.output_key
  const customBytes =
    customKey && input.evidence ? await input.evidence(customKey) : null
  const types = withCustomSections(
    checkTypes(input.report),
    checkCustomSections(
      input.report,
      customBytes
        ? parseCustom(safeJson(new TextDecoder().decode(customBytes)))
        : null
    )
  )
  const axeKey = input.report.checks.find((c) => c.check === "axe")?.output_key
  const axeBytes =
    axeKey && input.evidence ? await input.evidence(axeKey) : null
  const axe = checkAxe(
    input.report,
    axeBytes ? parseAxe(safeJson(new TextDecoder().decode(axeBytes))) : null
  )
  const parsed = DeploymentManifest.safeParse(input.manifest)
  if (!parsed.success) {
    const unreadable =
      "the manifest does not parse, so the pages could not be read"
    return [
      await checkBuild(input.manifest, read),
      types,
      fail("links", unreadable),
      fail("structured_data", unreadable),
      fail("content", unreadable),
      fail("claims", unreadable),
      fail("copy", unreadable),
      axe,
      fail("size", unreadable),
    ]
  }
  const decoder = new TextDecoder()
  const readStarted = Date.now()
  const [build, built] = await Promise.all([
    (async () => {
      const started = Date.now()
      const result = await checkBuild(input.manifest, read)
      if (input.timings) input.timings.build = Date.now() - started
      return result
    })(),
    (async () => {
      const found = await Promise.all(
        Object.keys(parsed.data.files)
          .filter((f) => f.endsWith(".html"))
          .sort()
          .map(async (file) => {
            const bytes = await read(file)
            if (!bytes) return null
            const html = decoder.decode(bytes)
            return { page: parsePage(file, html), html }
          })
      )
      if (input.timings) input.timings.read = Date.now() - readStarted
      return found.filter((each) => each !== null)
    })(),
  ])
  const pages = built.map((each) => each.page)
  const gap = input.plan
    ? (checkPlannedPages(input.plan, parsed.data.files) ??
      checkPlannedSections(
        input.plan,
        built.map(({ page, html }) => ({ file: page.file, html }))
      ))
    : null
  return [
    build.passed && gap ? gap : build,
    types,
    lap("links", () => checkLinks(pages, parsed.data.files)),
    lap("structured_data", () => checkStructuredData(pages)),
    lap("content", () => checkContent(pages, input.facts, input.hosts)),
    lap("claims", () => checkClaims(pages, input.facts, input.plan)),
    lap("copy", () =>
      checkCopy(
        built.map(({ page, html }) => ({ file: page.file, html })),
        input.plan !== undefined,
        input.facts
      )
    ),
    axe,
    await (async () => {
      const started = Date.now()
      const result = await checkSize(parsed.data.files, read, input.budget)
      if (input.timings) input.timings.size = Date.now() - started
      return result
    })(),
  ]
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export type { Located }
