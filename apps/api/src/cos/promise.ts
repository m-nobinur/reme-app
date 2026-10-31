import type { FactRecord } from "@workspace/contracts"
import { claimFindings } from "@workspace/gates/claims"
import { contentClaimsIn } from "@workspace/gates/text"
import {
  type LanguageModel,
  type LanguageModelMiddleware,
  wrapLanguageModel,
} from "ai"
import { IN_REVIEW } from "./labels.ts"

type WrapStream = NonNullable<LanguageModelMiddleware["wrapStream"]>
type Result = Awaited<ReturnType<WrapStream>>
type Part = Result["stream"] extends ReadableStream<infer P> ? P : never
type Finish = Extract<Part, { type: "finish" }>
export type Prompt = Parameters<WrapStream>[0]["params"]["prompt"]

/**
 * One reading of the text a call ended on, against the prompt it was sent:
 * the note to run the model again with, or null to let the turn end.
 */
export type Check = (said: string, prompt: Prompt) => Promise<string | null>

/**
 * A step that ends on text alone ends the turn, since the SDK goes round
 * again only after a tool call. So a reply that promises work ("I'll set
 * that up now") and stops would leave the owner waiting on nothing. This asks
 * the model once more inside the same step, so whatever it then calls runs
 * through the SDK as any tool call does. The nudge is part of this call's
 * prompt only: it is not in the log, and not in the `cos.call` hash, which
 * covers the log's messages. The step's logged message holds the promise and
 * what followed it.
 */

/** What the model is told after a promise with no tool call. */
export const NUDGE =
  "You said you would do something but made no tool call. Do it now with your tools, or say plainly what stops you. Do not promise it again."

/** Re-runs in one turn, whichever check asked for them. */
export const MAX_RERUNS = 2

/** What the model is told after a claim nothing it was shown backs; the claims follow. */
export const CLAIMS_NOTE =
  "Your reply says something is done or waits on the owner, or states a detail about the business, that nothing you were shown backs. Say only what a tool result in this turn, the workspace, the facts or the owner's words show; check with a tool if you can, or say plainly you are not sure. Do not repeat the claim. It was:"

/** Two calls' usage as one step's: counts added, anything else as the later call has it. */
function added<T>(first: T, later: T): T {
  if (typeof first === "number" && typeof later === "number") {
    return (first + later) as T
  }
  const plain = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
  if (plain(first) && plain(later)) {
    return Object.fromEntries(
      [...new Set([...Object.keys(first), ...Object.keys(later)])].map(
        (key) => [key, added(first[key], later[key])]
      )
    ) as T
  }
  return later ?? first
}

/** The promise check: `promised` true runs the model again with `NUDGE`. */
export const promiseGate =
  (promised: (said: string) => Promise<boolean>): Check =>
  async (said) =>
    (await promised(said)) ? NUDGE : null

/**
 * The checks read the text a call ended on in order, and the first note
 * runs the model again, at most `MAX_RERUNS` times for the middleware's
 * life, which is one turn. Text streams as it comes and only the finish is
 * held back until the reading is in. A check that throws passes.
 */
function rerunGate(checks: readonly Check[]): LanguageModelMiddleware {
  let reruns = 0
  return {
    wrapStream: async ({ doStream, params, model }) => {
      const first = await doStream()
      let said = ""
      let calls = 0
      let finish: Finish | undefined
      const seen = (part: Part) => {
        if (part.type === "text-delta") said += part.delta
        if (part.type === "tool-call") calls++
      }
      const stream = first.stream.pipeThrough(
        new TransformStream<Part, Part>({
          transform(part, controller) {
            if (part.type === "finish") finish = part
            else {
              seen(part)
              controller.enqueue(part)
            }
          },
          async flush(controller) {
            let prompt = params.prompt
            const noted = async () => {
              if (
                finish?.finishReason.unified !== "stop" ||
                calls > 0 ||
                !said.trim() ||
                reruns >= MAX_RERUNS
              )
                return null
              for (const check of checks) {
                const note = await check(said, params.prompt).catch(() => null)
                if (note) return note
              }
              return null
            }
            for (;;) {
              const note = await noted()
              if (!note) break
              reruns++
              prompt = [
                ...prompt,
                { role: "assistant", content: [{ type: "text", text: said }] },
                { role: "user", content: [{ type: "text", text: note }] },
              ]
              // A note comes only after a finish.
              const before = finish as Finish
              finish = undefined
              said = ""
              const reader = (
                await model.doStream({ ...params, prompt })
              ).stream.getReader()
              for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                if (value.type === "finish") {
                  finish = {
                    ...value,
                    usage: added(before.usage, value.usage),
                    providerMetadata: added(
                      before.providerMetadata,
                      value.providerMetadata
                    ) as Finish["providerMetadata"],
                  }
                } else if (value.type !== "stream-start") {
                  seen(value)
                  // Its own ids, so its blocks never meet the first call's.
                  controller.enqueue(
                    "id" in value && typeof value.id === "string"
                      ? { ...value, id: `${value.id}:${reruns}` }
                      : value
                  )
                }
              }
            }
            if (finish) controller.enqueue(finish)
          },
        })
      )
      return { ...first, stream }
    },
  }
}

/** The CoS model, with a reply a check reads as unfinished or unbacked run again. */
export const gated = (model: LanguageModel, checks: readonly Check[]) =>
  typeof model === "string"
    ? model
    : wrapLanguageModel({
        model: model as never,
        middleware: rerunGate(checks),
      })

/** An evidence entry as the model reads it, its ids dropped. */
type Shown = { kind?: unknown; status?: unknown }

/**
 * A done state: "it's live", "I've booked", "you're all set". "Set to" names
 * a value ("your hours are set to 9 to 5"), which the facts check reads.
 */
const DONE =
  /\b(?:it['’]?s|it is|that['’]?s|that is|is|are|now|i['’]?ve|i have|has been|have been|all)\s+(?:now\s+)?(live|set(?!\s+to\b)|booked|published|connected)\b/i

/** Words before a done state that make it a condition, a future or a no. */
const NOT_DONE =
  /\b(?:once|when|until|till|after|before|as soon as|if|whether|will|won['’]t|not|never)\b|['’]ll\b/i

/** Opening hours or a service area, which only the decision model can match. */
const HOURS_OR_AREA =
  /\b(?:opening hours|hours (?:are|is)|open (?:from|until|till|between|on|at|\d)|closed on|service area|we (?:cover|serve)|areas? (?:we|you) (?:cover|serve))\b/i

/** Every done state `said` states as done: questions, conditions and futures aside. */
export function doneClaims(said: string): string[] {
  return said
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((line) => !line.trim().endsWith("?"))
    .flatMap((line) => {
      const m = DONE.exec(line)
      return m && !NOT_DONE.test(line.slice(0, m.index)) ? [m[0]] : []
    })
}

/** A thing said to wait on the owner, or a site said not to be live. Conditions and futures are not claims, as for `DONE`. */
const PENDING =
  /\b(?:waiting (?:for|on) your (?:approval|answer)|ready (?:for you )?to publish|tap publish|(?:not|isn['’]t) live yet|needs? your (?:approval|answer))\b/i

/** Every pending state `said` states as so: questions, conditions and futures aside. */
export function pendingClaims(said: string): string[] {
  return said
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((line) => !line.trim().endsWith("?"))
    .flatMap((line) => {
      const m = PENDING.exec(line)
      return m && !NOT_DONE.test(line.slice(0, m.index)) ? [m[0]] : []
    })
}

/** The workspace as `workspaceLabels` shows it, as far as a done or pending state reads it. */
type Workspace = {
  site?: { live?: unknown }
  builds?: { state?: unknown }[]
  questions?: unknown[]
  reviews_waiting?: unknown
  domains?: { state?: unknown }[]
  reminders?: unknown[]
}

/** The workspace block of the turn's context, which `contextOf` writes. */
const WORKSPACE_DATA = /<data source="workspace"[^>]*>\n([\s\S]*?)\n<\/data>/

const workspaceIn = (text: string): Workspace | null => {
  const block = WORKSPACE_DATA.exec(text)?.[1]
  if (!block) return null
  try {
    return JSON.parse(block) as Workspace
  } catch {
    return null
  }
}

/**
 * Whether the turn backs a done state. A new action is backed by its
 * evidence since the owner's latest message; what already stands, by the
 * workspace the turn read from the database. Live and published need a page
 * that answered 2xx, a site the workspace shows live, or a connected domain
 * ("connected" is `labels.ts`'s word for an active one); set and booked, a
 * reminder it lists.
 */
const backs = (
  claim: string,
  evidence: readonly Shown[],
  workspace: Workspace | null
) => {
  const connected =
    workspace?.domains?.some((d) => d.state === "connected") ?? false
  if (/live|published/i.test(claim))
    return (
      workspace?.site?.live === true ||
      connected ||
      evidence.some(
        (e) =>
          e.kind === "url" &&
          typeof e.status === "number" &&
          e.status >= 200 &&
          e.status < 300
      )
    )
  if (/connected/i.test(claim)) return connected || evidence.length > 0
  return evidence.length > 0 || (workspace?.reminders?.length ?? 0) > 0
}

/**
 * Whether the workspace the turn read agrees that something waits: a review
 * or a build in a review state, an open question, or a site not yet live.
 * With no workspace in the turn there is nothing to disagree with.
 */
const waits = (claim: string, workspace: Workspace | null) => {
  if (!workspace) return true
  if (/live/i.test(claim)) return workspace.site?.live === false
  if (/answer/i.test(claim)) return (workspace.questions?.length ?? 0) > 0
  return (
    Number(workspace.reviews_waiting) > 0 ||
    (workspace.builds?.some((b) => IN_REVIEW.has(String(b.state))) ?? false)
  )
}

/**
 * What the turn was shown, out of `prompt`: the owner's messages, the
 * turn's context and every tool result's value; the evidence in the tool
 * results since the owner's latest message; and the newest workspace, from
 * the context or a get_workspace since that message. The model's own words
 * and the instructions say nothing about the business.
 */
export function shownIn(prompt: Prompt): {
  seen: unknown[]
  evidence: Shown[]
  workspace: Workspace | null
} {
  const owner = prompt.map((m) => m.role).lastIndexOf("user")
  const seen: unknown[] = []
  const evidence: Shown[] = []
  let workspace: Workspace | null = null
  prompt.forEach((message, at) => {
    if (message.role === "user") {
      for (const part of message.content) {
        if (part.type !== "text") continue
        seen.push(part.text)
        workspace = workspaceIn(part.text) ?? workspace
      }
    }
    if (message.role !== "tool") return
    for (const part of message.content) {
      if (part.type !== "tool-result") continue
      const { output } = part
      if (output.type !== "json" && output.type !== "text") continue
      seen.push(output.value)
      const listed =
        output.type === "json" &&
        typeof output.value === "object" &&
        output.value !== null &&
        "evidence" in output.value
          ? output.value.evidence
          : null
      if (at > owner && Array.isArray(listed))
        evidence.push(...(listed as Shown[]))
      if (at > owner && part.toolName === "get_workspace")
        workspace = output.value as Workspace
    }
  })
  return { seen, evidence, workspace }
}

/**
 * What the turn was shown, as facts the claims rules read: a key under
 * `about.` supports a claim word, and a quote has to sit in a
 * `testimonials.` fact whose customer agreed to it.
 */
const asFacts = (seen: unknown[]) =>
  [
    { key: "about.seen", value: seen, provenance: { source: "owner_stated" } },
    {
      key: "testimonials.seen",
      value: { permission: true, seen },
      provenance: { source: "owner_stated" },
    },
  ] as unknown as FactRecord[]

/** What the reply may state only as the turn was shown it. A time is left out: it is read in too many zones to match. */
const CONTENT = new Set(["price", "phone", "email", "postcode"])

/**
 * What in `said` nothing in `prompt` backs. `unbacked` is sure: a done
 * state with no evidence this turn, a contact, a postcode or a count, or a
 * price when the turn was shown none. `unclear` may be a paraphrase or a sum
 * of the owner's figures: a price when some were shown, a claim word, a
 * quote, opening hours or a service area.
 */
export function readClaims(
  said: string,
  prompt: Prompt
): { unbacked: string[]; unclear: string[]; seen: unknown[] } {
  const { seen, evidence, workspace } = shownIn(prompt)
  const unbacked = [
    ...doneClaims(said).filter((c) => !backs(c, evidence, workspace)),
    ...pendingClaims(said).filter((c) => !waits(c, workspace)),
  ]
  const unclear: string[] = []
  const shown = new Set(
    contentClaimsIn(JSON.stringify(seen)).map((c) => `${c.kind}:${c.key}`)
  )
  const pricesShown = [...shown].some((k) => k.startsWith("price:"))
  for (const c of contentClaimsIn(said)) {
    if (!CONTENT.has(c.kind) || shown.has(`${c.kind}:${c.key}`)) continue
    if (c.kind === "price" && pricesShown) unclear.push(c.text)
    else unbacked.push(c.text)
  }
  const page = {
    file: "reply",
    texts: [{ value: said, node: "reply" }],
    links: [],
    jsonLd: [],
  }
  for (const f of claimFindings([page], asFacts(seen))) {
    if (f.kind === "number") unbacked.push(f.claim)
    else unclear.push(f.claim)
  }
  const area = HOURS_OR_AREA.exec(said)
  if (area) unclear.push(area[0])
  return { unbacked, unclear, seen }
}

/**
 * The claims check: a done state or a business detail in the closing text
 * that the turn was not shown runs the model again with `CLAIMS_NOTE` and
 * the claims, once a turn. `unsure` is asked only when nothing is sure but
 * something is unclear, with the reply and what the turn was shown; one that
 * throws passes the reply.
 */
export function claimsGate(
  unsure: (said: string, seen: string) => Promise<boolean>
): Check {
  let ran = false
  return async (said, prompt) => {
    if (ran) return null
    const { unbacked, unclear, seen } = readClaims(said, prompt)
    const rerun =
      unbacked.length > 0 ||
      (unclear.length > 0 &&
        (await unsure(said, JSON.stringify(seen)).catch(() => false)))
    if (!rerun) return null
    ran = true
    const claims = [...unbacked, ...unclear].map((c) => `"${c}"`)
    return `${CLAIMS_NOTE} ${claims.join(", ")}.`
  }
}
