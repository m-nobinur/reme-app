// The Monday search message: a fixed template, no model call. Every query and
// page it quotes was typed or published by someone else, so each goes through
// `cleanQuery` and sits inside quotes or a name, never in the sentence's shape.
import type { SearchConnectionState } from "@workspace/contracts"
import { cleanQuery, type Suggestion, type Window } from "./search-rules.ts"

type When = Date | string

export type ReportInput = {
  /** `never` is no connection row; `revoked` is the owner's own disconnect. */
  state: SearchConnectionState | "never"
  pausedOn?: When
  declined?: boolean
  /** The one reminder has already been sent. */
  reminded?: boolean
  thisWeek?: Window
  lastWeek?: Window | null
  suggestion?: Suggestion | null
}
export type Report = { text: string[]; chips: string[] }

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")
const n = (x: number) => x.toLocaleString("en-GB")
const plural = (x: number, one: string, many = `${one}s`) =>
  `${n(x)} ${x === 1 ? one : many}`
const pct = (x: number) => `${+(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`
const change = (now: number, before?: number) =>
  !before
    ? ""
    : now === before
      ? " (same as last week)"
      : ` (${now > before ? "+" : "-"}${Math.round((Math.abs(now - before) / before) * 100)}%)`

/** "https://x.co.uk/deep-clean" -> "Deep clean"; the home page is "Home". */
function pageName(url: string): string {
  let path = ""
  try {
    path = decodeURIComponent(new URL(url).pathname)
  } catch {
    // a malformed address reads as the home page
  }
  const last = path.split("/").filter(Boolean).pop() ?? ""
  const words = cleanQuery(last.replace(/[-_]+/g, " "))
  return words ? words[0]?.toUpperCase() + words.slice(1) : "Home"
}

function about(s: Suggestion): string {
  switch (s.kind) {
    case "low_ctr":
      return `Your ${pageName(s.page)} page shows up a lot for "${cleanQuery(s.query)}" but few people click it (${pct(s.ctr)} of those who see it, at position ${Math.round(s.position)}). A clearer title and description would likely help.`
    case "striking_distance":
      return `Your ${pageName(s.page)} page is close to the first page of results for "${cleanQuery(s.query)}", at position ${Math.round(s.position)}. A short section or an answer to a common question on it could help.`
    case "unknown_to_google":
      return `Google doesn't know about ${plural(s.urls.length, "page")} on your site yet. I'll send your page list again and check them in 7 days.`
    case "crawled_not_indexed": {
      const names = s.urls.slice(0, 3).map(pageName).join(", ")
      return `Google has seen ${plural(s.urls.length, "page")} (${names}) but chose not to index ${s.urls.length === 1 ? "it" : "them"} yet. That usually means a page isn't distinct enough. There's no button to force it. What helps is giving each page something only it has. Do you have a real job, review or detail for ${s.urls.length === 1 ? "it" : "each"}?`
    }
    case "drop":
      return `Clicks fell from ${n(s.previous)} to ${n(s.current)} week on week. I'm checking your busiest pages with Google.`
    case "result": {
      const { before: b, after: a } = s
      const from = s.query ? ` from "${cleanQuery(s.query)}"` : ""
      const near = Math.abs(a.position - b.position) < 1
      const where = near
        ? "at about the same position"
        : `with position moving from ${Math.round(b.position)} to ${Math.round(a.position)}`
      return s.outcome === "same"
        ? `Since the change to your ${pageName(s.page)} page went live, clicks${from} stayed about the same over 28 days (${n(b.clicks)} before, ${n(a.clicks)} after), ${where}. It made no clear difference.`
        : `Since the change to your ${pageName(s.page)} page went live, clicks${from} went from ${n(b.clicks)} to ${n(a.clicks)} over 28 days, ${where}.`
    }
  }
}

/** The weekly message, or null when there is nothing to say. */
export function weeklyReport(input: ReportInput): Report | null {
  if (input.state === "revoked") return null
  if (input.state === "never") {
    if (input.declined || input.reminded) return null
    return {
      text: [
        "Want me to put your site on Google Search and track how people find you? You sign in with Google once. After that I handle it.",
      ],
      chips: ["Connect Google", "Later"],
    }
  }
  // A box left unticked is fixed the same way: sign in again.
  if (input.state === "needs_reauth" || input.state === "needs_permission") {
    const d = input.pausedOn ? new Date(input.pausedOn) : null
    const on = d ? ` on ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : ""
    return {
      text: [`Search data paused${on}. Google needs you to sign in again.`],
      chips: ["Connect Google"],
    }
  }
  const w = input.thisWeek
  if (!w) return null
  const head = `Search this week: ${plural(w.impressions, "appearance")}${change(w.impressions, input.lastWeek?.impressions)}, ${plural(w.clicks, "click")}${w.impressions ? `, average position ${Math.round(w.position)}` : ""}.`
  const s = input.suggestion
  return s
    ? { text: [head, about(s)], chips: s.chips }
    : { text: [head], chips: [] }
}
