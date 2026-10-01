import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { loadSession } from "../replay.mjs"

/**
 * Tier 1 (§16.3): how the Developer edits. Over every recorded Developer
 * session: a starter file is changed with `edit`, never rewritten with
 * `write`; every failed edit answers with Pi's anchor message and is
 * recovered by one retry: the next edit of that file succeeds, the model
 * reads the file again before it, the retry comes within two turns of that
 * read, and nothing changes the site in between. The bound counts from the
 * read, not the failure: with the 33-file starter (N5) a model that was made
 * to edit before reading anything reads the whole site first, a turn the
 * 9-file fixture never needed.
 * The recovery session plants the failure: its goal makes the first call an
 * edit, before any read, quoting an anchor with single quotes where the file
 * has double quotes, which the edit does not forgive.
 */

const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url))

/** The files the starter seeds, as the Developer sees them. */
const STARTER = new Set([
  ".gitignore",
  "astro.config.mjs",
  "package.json",
  "src/components/ActionLink/ActionLink.astro",
  "src/components/ActionLink/manifest.yaml",
  "src/components/ContactDetails/ContactDetails.astro",
  "src/components/ContactDetails/manifest.yaml",
  "src/components/Hero/Hero.astro",
  "src/components/Hero/manifest.yaml",
  "src/components/Section/Section.astro",
  "src/components/Section/manifest.yaml",
  "src/components/Seo/Seo.astro",
  "src/components/Seo/manifest.yaml",
  "src/components/SiteFooter/SiteFooter.astro",
  "src/components/SiteFooter/manifest.yaml",
  "src/components/SiteHeader/SiteHeader.astro",
  "src/components/SiteHeader/manifest.yaml",
  "src/layouts/Base.astro",
  "src/pages/404.astro",
  "src/pages/contact.astro",
  "src/pages/index.astro",
  "src/pages/quote.astro",
  "src/pages/robots.txt.ts",
  "src/pages/service-area.astro",
  "src/pages/services.astro",
  "src/pages/sitemap.xml.ts",
  "src/routes.ts",
  "src/site-config.ts",
  "src/structured-data.ts",
  "src/styles/site.css",
  "src/styles/tokens.css",
  "tsconfig.json",
])

const relative = (path) =>
  String(path ?? "").replace(/^\/workspace\/site\//, "")

/** Calls that change the site or report on it; none may come between a failed edit and its retry. */
const MUTATING = new Set(["edit", "write", "checkpoint", "report_complete"])

/** Tool calls with their arguments and results, in the order the log holds them. */
function calls(events) {
  const turns = events
    .filter((e) => e.type === "runtime.turn_messages")
    .sort((a, b) => a.seq - b.seq)
  const out = []
  turns.forEach((turn, index) => {
    const requested = (turn.payload.message?.content ?? []).filter(
      (c) => c.type === "toolCall"
    )
    const results = turn.payload.toolResults ?? []
    for (const call of requested) {
      const result = results.find((r) => r.toolCallId === call.id)
      out.push({
        turn: index,
        name: call.name,
        path: relative(call.arguments?.path),
        isError: Boolean(result?.isError),
        text: (result?.content ?? []).map((c) => c.text ?? "").join(""),
      })
    }
  })
  return out
}

export default async function developerEdits() {
  const names = readdirSync(fixtures).filter(
    (n) => n.startsWith("developer-") && n.endsWith(".jsonl")
  )
  let recovered = 0
  for (const name of names) {
    const session = loadSession(`${fixtures}${name}`)
    if (!session) continue
    const all = calls(session.events)
    for (const c of all) {
      if (c.name === "write" && STARTER.has(c.path)) {
        throw new Error(
          `${name}: ${c.path} was rewritten with write in turn ${c.turn}`
        )
      }
    }
    for (const failed of all.filter((c) => c.name === "edit" && c.isError)) {
      if (!/Could not find|Found \d+ occurrences/.test(failed.text)) {
        throw new Error(
          `${name}: a failed edit said "${failed.text.slice(0, 120)}"`
        )
      }
      const after = all.slice(all.indexOf(failed) + 1)
      const next = after.find(
        (c) => c.name === "edit" && c.path === failed.path
      )
      const between = next ? after.slice(0, after.indexOf(next)) : after
      const reread = between.find(
        (c) => c.name === "read" && c.path === failed.path
      )
      const changed = between.find((c) => MUTATING.has(c.name))
      if (
        !next ||
        next.isError ||
        !reread ||
        changed ||
        next.turn > reread.turn + 2
      ) {
        throw new Error(
          `${name}: the failed edit of ${failed.path} in turn ${failed.turn} was not recovered by one retry within two turns of reading it again${changed ? ` (${changed.name} in turn ${changed.turn} came first)` : ""}`
        )
      }
      recovered++
    }
  }
  const planted = loadSession(`${fixtures}developer-edit-recovery.jsonl`)
  if (!planted)
    throw new Error("developer-edit-recovery is not a session fixture")
  if (!calls(planted.events).some((c) => c.name === "edit" && c.isError)) {
    throw new Error(
      "developer-edit-recovery holds no failed edit to recover from"
    )
  }
  if (recovered === 0)
    throw new Error("no failed edit was recovered in any session")
}
