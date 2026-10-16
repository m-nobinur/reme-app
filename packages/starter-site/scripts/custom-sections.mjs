/**
 * `node scripts/custom-sections.mjs [siteRoot] [out.json]`: the rules for a
 * section the builder writes under `src/components/custom/` (ADR-038, VS8).
 *
 *   tokens       no raw colour: hex, rgb(), oklch() and the like, or a named colour
 *   fonts        no font family: `font-family` is `var(--font-…)`, no @font-face
 *   no-script    no <script>, event handler, client: directive or javascript: URL
 *   empty        the markup is one `{ content && (…) }`, so no content renders nothing
 *   site-config  no prose in the file and no import from outside the site
 *   count        at most two sections, each a PascalCase .astro file
 *
 * Plain Node and no dependencies: the orchestrator writes this file into the
 * build sandbox and runs it there, so what runs is not what the Developer
 * could have edited. It reads text, so it holds to the starter's own idiom
 * (see Faq.astro) and not to everything Astro accepts.
 *
 * shortcut: a one-word prose literal ("Contact") passes the site-config rule,
 * and the empty rule checks the shape of the guard, not what it tests;
 * upgrade to rendering the section with empty content if either bites.
 *
 * Exit 0 clean, 1 findings. With `out.json` the findings go there as
 * `{findings: [{file, rule, message}]}`, which the gate reads.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

export const DIR = "src/components/custom"
export const MAX_SECTIONS = 2

const NAMED = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen`.split(
    " "
  )
)
const COLOUR_PROP =
  /^(--[\w-]+|color|fill|stroke|stop-color|flood-color|caret-color|accent-color|background(-color|-image)?|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?|outline(-color)?|column-rule(-color)?|box-shadow|text-shadow|text-decoration(-color)?)$/i
const VOID = new Set(
  "area base br col embed hr img input link meta source track wbr".split(" ")
)
// A literal that reads as words: it has a letter and is not a path, key or token.
const prose = (s) => /\p{L}/u.test(s) && !/^[\w@.:/#-]+$/.test(s)

/** Declarations in a style block or a style attribute. */
function css(source) {
  const out = []
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "")
  if (/@font-face|@import/i.test(text))
    out.push(["fonts", "@font-face and @import bring a font the pair does not"])
  for (const [, prop, raw] of text.matchAll(/([\w-]+)\s*:\s*([^;{}]+)/g)) {
    const p = prop.toLowerCase()
    const value = raw.replace(/url\([^)]*\)/g, "").trim()
    if (
      (p === "font-family" && !/^(var\(--[\w-]+\)|inherit)$/i.test(value)) ||
      (p === "font" && !/^inherit$/i.test(value))
    )
      out.push(["fonts", `${p}: ${value} names a font; use var(--font-…)`])
    // var(--x) alone is a token; a fallback inside var() is still checked.
    const bare = value.replace(/var\(--[\w-]+\)/g, "")
    const named = COLOUR_PROP.test(p)
      ? (bare.toLowerCase().match(/[a-z]+/g) ?? []).find((w) => NAMED.has(w))
      : undefined
    if (
      /#[0-9a-f]{3,8}\b/i.test(bare) ||
      /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i.test(bare) ||
      named
    )
      out.push([
        "tokens",
        `${p}: ${value} is a raw colour; use a var(--…) token`,
      ])
  }
  return out
}

/** Attribute rules; `value` is the literal text of a quoted or string-valued attribute. */
function attribute(name, value, report) {
  const n = name.toLowerCase()
  if (n === "style") for (const f of css(value)) report(...f)
  else if (
    /^(alt|title|aria-label|aria-description|placeholder|label|content|value)$/.test(
      n
    )
  ) {
    if (/\p{L}/u.test(value))
      report(
        "site-config",
        `${name}="${value}" is written in the markup; read it from site-config`
      )
  } else if (n === "href") {
    if (/^\s*javascript:/i.test(value)) report("no-script", "a javascript: URL")
    else if (value && !/^[/#]/.test(value))
      report(
        "site-config",
        `href="${value}" is written in the markup; read it from site-config`
      )
  } else if (/^(src|srcset|poster)$/.test(n) && value)
    report(
      "site-config",
      `${name}="${value}" is written in the markup; read it from site-config`
    )
}

/** The markup after the frontmatter, scripts and styles have been taken out. */
function markup(src, report) {
  const end = (j) => {
    const q = src[j]
    let k = j + 1
    while (k < src.length && src[k] !== q) k += src[k] === "\\" ? 2 : 1
    return k + 1
  }
  // Past a balanced { … }, knowing strings, and with no findings.
  const skip = (j) => {
    let depth = 0
    for (; j < src.length; j++) {
      const c = src[j]
      if (c === '"' || c === "'" || c === "`") j = end(j) - 1
      else if (c === "{") depth++
      else if (c === "}" && --depth === 0) return j + 1
    }
    return j
  }
  const text = (t) => {
    if (/[\p{L}\p{N}]/u.test(t))
      report(
        "site-config",
        `the text "${t.trim().slice(0, 40)}" is written in the markup; read it from site-config`
      )
  }
  // A { … } child: strings in it are text, and markup in it is an element.
  const expr = (i) => {
    let j = i + 1
    let depth = 0
    while (j < src.length) {
      const c = src[j]
      if (c === '"' || c === "'" || c === "`") {
        const e = end(j)
        const s = src.slice(j + 1, e - 1).replace(/\$\{[^}]*\}/g, "")
        if (prose(s))
          report(
            "site-config",
            `the string "${s.slice(0, 40)}" is written in the markup; read it from site-config`
          )
        j = e
      } else if (c === "/" && src[j + 1] === "/" && /[\s{;]/.test(src[j - 1])) {
        j = src.indexOf("\n", j) < 0 ? src.length : src.indexOf("\n", j)
      } else if (
        c === "<" &&
        /[A-Za-z>]/.test(src[j + 1] ?? "") &&
        /[(&|?:,={[>]$/.test(src.slice(0, j).trimEnd())
      ) {
        j = element(j)
      } else {
        if (c === "{") depth++
        if (c === "}" && depth-- === 0) return j + 1
        j++
      }
    }
    return j
  }
  const children = (i) => {
    let j = i
    let t = ""
    while (j < src.length) {
      const c = src[j]
      if (c === "<" && src[j + 1] === "/") {
        text(t)
        return src.indexOf(">", j) + 1 || src.length
      }
      if (c === "<" && /[A-Za-z>]/.test(src[j + 1] ?? "")) {
        text(t)
        t = ""
        j = element(j)
      } else if (c === "{") {
        text(t)
        t = ""
        j = expr(j)
      } else {
        t += c
        j++
      }
    }
    text(t)
    return j
  }
  const element = (i) => {
    let j = i + 1
    if (src[j] === ">") return children(j + 1)
    const name = /^[\w:.-]+/.exec(src.slice(j))?.[0] ?? ""
    j += name.length
    if (/^(script|iframe|object|embed|base|meta)$/i.test(name))
      report("no-script", `a <${name}> element loads or runs code`)
    let closed = false
    while (j < src.length) {
      while (/\s/.test(src[j] ?? "")) j++
      if (src.startsWith("/>", j)) {
        closed = true
        j += 2
        break
      }
      if (src[j] === ">") {
        j++
        break
      }
      if (src[j] === "{") {
        j = skip(j)
        continue
      }
      const attr = /^[^\s=>/{]+/.exec(src.slice(j))?.[0]
      if (!attr) {
        j++
        continue
      }
      j += attr.length
      if (/^on[a-z]/i.test(attr) || /^(client:|set:html$)/.test(attr))
        report("no-script", `${attr} runs script or raw HTML in the browser`)
      while (/\s/.test(src[j] ?? "")) j++
      if (src[j] !== "=") continue
      j++
      while (/\s/.test(src[j] ?? "")) j++
      if (src[j] === '"' || src[j] === "'") {
        const e = end(j)
        attribute(attr, src.slice(j + 1, e - 1), report)
        j = e
      } else if (src[j] === "{") {
        const e = skip(j)
        const lit = /^\s*(["'`])([\s\S]*)\1\s*$/.exec(src.slice(j + 1, e - 1))
        if (lit && !lit[2].includes("${")) attribute(attr, lit[2], report)
        j = e
      } else j += /^[^\s>]*/.exec(src.slice(j))?.[0].length ?? 0
    }
    return closed || VOID.has(name.toLowerCase()) ? j : children(j)
  }

  for (let k = 0; k < src.length; ) k = children(k)

  // Empty content renders nothing: one expression, guarded by && or a ternary to null.
  const body = src.trim()
  if (!body) return
  if (
    !body.startsWith("{") ||
    skip(src.indexOf("{")) !== src.trimEnd().length
  ) {
    report(
      "empty",
      "the markup must be one { content && ( … ) }, so a section with no content renders nothing"
    )
    return
  }
  const inner = body.slice(1, -1)
  const tag = inner.search(/<[A-Za-z>]/)
  if (tag < 0) return
  const head = inner.slice(0, tag).trimEnd().replace(/\($/, "").trimEnd()
  const ternary =
    /\?$/.test(head) &&
    /:\s*(null|undefined|false|""|'')\s*\)?\s*$/.test(inner.trimEnd())
  if (!/&&$/.test(head) && !ternary)
    report(
      "empty",
      "the markup's condition must end in && ( … ) or ? ( … ) : null, so no content renders nothing"
    )
}

/** The findings for one file's text: `[{rule, message}]`. */
export function lintSource(source) {
  const found = []
  const report = (rule, message) => {
    if (!found.some((f) => f.rule === rule && f.message === message))
      found.push({ rule, message })
  }
  const fm = /^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  const front = (fm?.[1] ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
  let body = (fm ? source.slice(fm[0].length) : source)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
  if (/<script\b/i.test(body)) report("no-script", "a <script> element")
  body = body.replace(/<script\b[\s\S]*?<\/script>/gi, "")
  for (const m of body.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))
    for (const f of css(m[1])) report(...f)
  body = body.replace(/<style\b[\s\S]*?<\/style>/gi, "")

  const from = [...front.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map(
    (m) => m[1]
  )
  if (!from.some((s) => /(^|\/)site-config(\.ts)?$/.test(s)))
    report(
      "site-config",
      "the section imports nothing from site-config, so its content is written in the file"
    )
  for (const s of from)
    if (!/^(\.|astro:)/.test(s))
      report("site-config", `imports ${s}, which is outside the site`)
  if (/\bfetch\s*\(|\bAstro\.glob\b|import\.meta\.glob/.test(front))
    report("site-config", "reads content from somewhere other than site-config")
  for (const [, , s] of front.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g))
    if (prose(s))
      report(
        "site-config",
        `the string "${s.slice(0, 40)}" is written in the file; read it from site-config`
      )

  markup(body, report)
  return found
}

/** Every rule over a site's custom folder: `[{file, source}]` in, `[{file, rule, message}]` out. */
export function lintSite(entries) {
  const out = []
  const sorted = [...entries].sort((a, b) => (a.file < b.file ? -1 : 1))
  const sections = sorted.filter((e) => e.file.endsWith(".astro"))
  for (const e of sorted) {
    const at = `${DIR}/${e.file}`
    if (!e.file.endsWith(".astro"))
      out.push({
        file: at,
        rule: "count",
        message:
          "only .astro files go in custom/, since a .ts or .js file is script",
      })
    else if (!/^[A-Z][A-Za-z0-9]{2,39}\.astro$/.test(e.file))
      out.push({
        file: at,
        rule: "count",
        message: "a section is named like a component, PascalCase",
      })
    else for (const f of lintSource(e.source)) out.push({ file: at, ...f })
  }
  for (const e of sections.slice(MAX_SECTIONS))
    out.push({
      file: `${DIR}/${e.file}`,
      rule: "count",
      message: `a site has at most ${MAX_SECTIONS} custom sections`,
    })
  return out
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const dir = join(process.argv[2] ?? ".", DIR)
  const entries = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => ({
          file: d.name,
          source: readFileSync(join(dir, d.name), "utf8"),
        }))
    : []
  const findings = lintSite(entries)
  if (process.argv[3])
    writeFileSync(process.argv[3], JSON.stringify({ findings }))
  for (const f of findings) console.error(`${f.file}: ${f.rule}: ${f.message}`)
  process.exit(findings.length > 0 ? 1 : 0)
}
