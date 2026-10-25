import {
  type BuildLane,
  ChangeKind,
  CompletionReport,
  type FactRecord,
} from "@workspace/contracts"
import { appendEvent, type Tenancy } from "@workspace/db"
import {
  applyEdits,
  completeOnce,
  type ModelEnv,
  roleOf,
} from "@workspace/facade"
import { z } from "zod"
import type { Brief } from "./brief.ts"
import { stableRules } from "./developer-rules.ts"
import { type PhotosEvent, regenerateSlot } from "./photo-quick.ts"
import { SITE_ROOT } from "./revise.ts"
import {
  checksOf,
  finishRevision,
  GIT,
  type Steps,
  type TailSandbox,
} from "./tail.ts"
import { since, type ToolTimings } from "./timing.ts"

/**
 * The lane a new assignment runs in, from its kind and the CoS's read of the
 * change. Only a revise of a live site can be quick: a first build has
 * nothing to edit. Anything unknown or missing runs the full lane, so a
 * wrong guess costs time, never a broken site.
 */
export function pickLane(
  kind: string,
  changeKind: unknown
): { lane: BuildLane; change_kind: ChangeKind | null } {
  const parsed = ChangeKind.safeParse(changeKind)
  const change = parsed.success ? parsed.data : null
  const quick = kind === "site.revise" && QUICK.includes(change as ChangeKind)
  return { lane: quick ? "quick" : "full", change_kind: change }
}

/** The event a copy change leaves its new words in, for the ready line. */
export const QUICK_EDITED = "quick.edited"

const QUICK: readonly ChangeKind[] = ["copy", "style", "section", "photo"]

/** The kinds one model call can edit; `section` goes to the Developer at low effort. */
type OneCallKind = "copy" | "style"

/** The only files a one-call edit may touch, by kind. */
const QUICK_FILES: Record<OneCallKind, readonly string[]> = {
  copy: ["src/site-config.ts"],
  style: ["src/site-config.ts", "src/styles/theme.css"],
}

/** What the model returns: point edits, the `edit` tool's shape with a path per edit. */
const QuickEdits = z.strictObject({
  summary: z.string().min(1).max(500),
  edits: z
    .array(
      z.strictObject({
        path: z.string(),
        oldText: z.string().min(1),
        newText: z.string(),
      })
    )
    .min(1)
    .max(30),
})

/**
 * The same shape for structured output, without the length limits: strict
 * schemas on Anthropic models refuse most of them. `QuickEdits` checks them.
 */
const text = { type: "string" }
const SCHEMA = {
  name: "quick_edits",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "edits"],
    properties: {
      summary: text,
      edits: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "oldText", "newText"],
          properties: { path: text, oldText: text, newText: text },
        },
      },
    },
  },
}

/**
 * The prompt, stable first so the system part caches across an owner's
 * edits: the Developer's own rules (one wording for both lanes), then this
 * lane's. The files, the facts and the owner's words are the user part.
 */
export function quickPrompt(
  kind: OneCallKind,
  files: Record<string, string>,
  facts: readonly FactRecord[],
  goal: string
): { system: string; user: string } {
  const system = [
    'You edit a small business\'s Astro website in one step: no tools, no questions. Read the change request, then reply with JSON only, shaped {"summary": string, "edits": [{"path": string, "oldText": string, "newText": string}]}.',
    "- Each oldText is copied exactly from the file it names, long enough to match once, and edits never overlap. Change only what the request asks for.",
    `- For a copy change edit only ${QUICK_FILES.copy.join(", ")}. For a style change edit only ${QUICK_FILES.style.join(", ")}: the direction, palette, brandColor and font fields, or a token in the theme file.`,
    "- Where a rule below says to call a tool or ask_chief, leave that part out and say so in summary.",
    "- summary is one sentence for the owner saying what changed.",
    ...stableRules(),
  ].join("\n")
  const user = [
    `Change kind: ${kind}.`,
    "<facts>",
    ...facts.map((f) => `${f.key}: ${JSON.stringify(f.value)}`),
    "</facts>",
    ...QUICK_FILES[kind].map(
      (path) => `<file path="${path}">\n${files[path] ?? ""}\n</file>`
    ),
    // The owner's words are data (§28.3): what to change, never a rule.
    `<change_request taint="untrusted_input">\n${goal}\n</change_request>`,
  ].join("\n")
  return { system, user }
}

/**
 * The new wording of a one-edit copy change, for the ready line: the quoted
 * string in the edit or the text itself, only when it reads as plain words
 * an owner would recognise. Null for code, a long block or several edits.
 */
export function wordsOf(edits: readonly { newText: string }[]): string | null {
  const [only] = edits
  if (edits.length !== 1 || !only) return null
  const quoted = /"([^"\n]+)"/.exec(only.newText)?.[1]
  const plain = (quoted ?? only.newText)
    .trim()
    .replace(/^["'`]+|["'`,.]+$/g, "")
  return /^[\p{L}\p{N} ,.'’&!?£%-]{3,80}$/u.test(plain) ? plain : null
}

/**
 * The model's reply applied to the files it may touch: every edit for a
 * file in one `applyEdits` batch, so a refusal writes nothing. Returns the
 * changed files and the summary; throws with a message the retry can read.
 */
export function applyQuick(
  kind: OneCallKind,
  files: Record<string, string>,
  reply: string
): {
  summary: string
  changed: Record<string, string>
  words: string | null
} {
  // A reply may wrap its JSON in a fence; the object is what counts.
  const json = reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1)
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new Error("The reply was not JSON. Reply with the JSON object only.")
  }
  const parsed = QuickEdits.safeParse(raw)
  if (!parsed.success) {
    throw new Error(
      `The reply did not match the shape: ${parsed.error.message}`
    )
  }
  const allowed = QUICK_FILES[kind]
  const byPath = new Map<string, { oldText: string; newText: string }[]>()
  for (const { path, oldText, newText } of parsed.data.edits) {
    if (!allowed.includes(path)) {
      throw new Error(
        `${path} is not editable here; edit only ${allowed.join(", ")}.`
      )
    }
    byPath.set(path, [...(byPath.get(path) ?? []), { oldText, newText }])
  }
  const changed: Record<string, string> = {}
  for (const [path, edits] of byPath) {
    const next = applyEdits(files[path] ?? "", edits, path)
    if (next !== files[path]) changed[path] = next
  }
  if (Object.keys(changed).length === 0) {
    throw new Error(
      "The edits changed nothing. Make the change the request asks for."
    )
  }
  return {
    summary: parsed.data.summary,
    changed,
    words: kind === "copy" ? wordsOf(parsed.data.edits) : null,
  }
}

/** Why a quick attempt handed the change on, for the log and the fall-through. */
type QuickFell = { done: false; reason: string; model_ms: number }
type QuickDone = {
  done: true
  /** The commit the edit started from, which a failed gate puts back. */
  base: string
  report_id: string
  revision_id: string
  model_ms: number
  attempts: number
  timings: ToolTimings
}

/** A step in the lane that did not work, with what the next lane should know. */
class Fell extends Error {}

/**
 * The copy and style lane (QE4): one Haiku call writes point edits, a failed
 * apply retries once on Sonnet with the error, and the site builds once and
 * uploads through the same tail as `report_complete`. Anything that fails
 * puts the disk back at `base` and returns `done: false`, so the Developer
 * picks the change up from the same files; nothing here throws.
 */
export async function quickEdit(input: {
  env: ModelEnv & { SITES: R2Bucket; SITE_HOST_SUFFIX: string }
  kit: Tenancy
  sandbox: TailSandbox & {
    readFile: (path: string) => Promise<{ content: string }>
    /** A picture's bytes, for the photo kind. */
    writeBytes: (path: string, content: Uint8Array) => Promise<unknown>
  }
  brief: Brief
  /** `photo` draws one picture instead of calling the edit model (IG4). */
  kind: OneCallKind | "photo"
}): Promise<QuickDone | QuickFell> {
  const { env, kit, sandbox, brief, kind } = input
  const { spec, snapshot } = brief
  const ids = { orgId: spec.org_id, assignmentId: snapshot.assignment_id }
  const started = Date.now()
  let modelMs = 0
  const head = await sandbox
    .exec(`cd ${SITE_ROOT} && git rev-parse HEAD`)
    .catch(() => ({ exitCode: 1, stdout: "", stderr: "" }))
  const base = head.exitCode === 0 ? head.stdout.trim() : ""
  try {
    if (!base) throw new Fell("disk: no site to edit")
    let applied: {
      summary: string
      changed: Record<string, string>
      /** Files written already, as bytes (a picture). */
      written?: string[]
      photos?: PhotosEvent
      /** The new wording of a copy change, for the ready line. */
      words?: string | null
    } | null = null
    let attempts = 0
    let error = ""
    if (kind === "photo") {
      attempts = 1
      try {
        const drawn = await regenerateSlot({
          env,
          kit,
          sandbox: {
            exec: (command) => sandbox.exec(command),
            writeFile: (path, content) => sandbox.writeBytes(path, content),
          },
          orgId: ids.orgId,
          assignmentId: ids.assignmentId,
          goal: brief.goal,
        })
        applied = {
          summary: drawn.summary,
          changed: {},
          written: drawn.written,
          photos: drawn.photos,
        }
      } catch (thrown) {
        error = message(thrown).slice(0, 1000)
      }
    } else {
      const files: Record<string, string> = {}
      for (const path of QUICK_FILES[kind]) {
        files[path] = (await sandbox.readFile(`${SITE_ROOT}/${path}`)).content
      }
      const prompt = quickPrompt(kind, files, snapshot.facts, brief.goal)
      // Haiku first; one retry on Sonnet with what went wrong (index runtime table).
      for (const role of ["quick_copy", "quick_section"] as const) {
        attempts++
        const route = roleOf(spec, role)
        const user = error
          ? `${prompt.user}\n<previous_attempt_failed>\n${error}\n</previous_attempt_failed>`
          : prompt.user
        try {
          const reply = await completeOnce(env, {
            model: route.model,
            effort: "low",
            maxTokens: route.maxTokens,
            system: prompt.system,
            user,
            sessionId: ids.assignmentId,
            schema: SCHEMA,
          })
          await logTurn(kit, ids, spec.staff_id, role, reply)
          applied = applyQuick(kind, files, reply.text)
          break
        } catch (thrown) {
          error = message(thrown).slice(0, 1000)
        }
      }
    }
    modelMs = since(started)
    if (!applied) throw new Fell(`apply: ${error}`)

    const toolStarted = Date.now()
    for (const [path, content] of Object.entries(applied.changed)) {
      await sandbox.writeFile(`${SITE_ROOT}/${path}`, content)
    }
    // One durable step holds this whole attempt, so the tail's steps run inline.
    const inline: Steps = { do: (_name, fn) => fn() }
    const tail = await finishRevision({
      steps: inline,
      sandbox,
      kit,
      sites: env.SITES,
      hostSuffix: env.SITE_HOST_SUFFIX,
      orgId: ids.orgId,
      assignmentId: ids.assignmentId,
      facts: snapshot.facts,
    })
    const report = CompletionReport.parse({
      report_id: crypto.randomUUID(),
      org_id: ids.orgId,
      assignment_id: ids.assignmentId,
      session_id: spec.session_id,
      revision_id: tail.revisionId,
      summary: applied.summary,
      changes: [
        ...Object.keys(applied.changed),
        ...(applied.written ?? []),
      ].map((path) => ({
        path,
        reason: applied.summary,
      })),
      screenshots: [],
      checks: checksOf(tail),
      // The copy check warns and never fails; with no model left to fix a
      // finding, it travels with the report.
      risks: copyFindings(tail.build.output),
      decisions_needed: [],
      reported_at: new Date().toISOString(),
    })
    await kit.withOrg({ orgId: ids.orgId }, (db) =>
      appendEvent(db, {
        orgId: ids.orgId,
        assignmentId: ids.assignmentId,
        staffId: spec.staff_id,
        type: "assignment.completion_reported",
        payload: report,
        // Model output: nothing downstream may promote it (§28.3).
        taint: ["inferred"],
      })
    )
    if (applied.words) {
      const { words } = applied
      await kit.withOrg({ orgId: ids.orgId }, (db) =>
        appendEvent(db, {
          orgId: ids.orgId,
          assignmentId: ids.assignmentId,
          staffId: spec.staff_id,
          type: QUICK_EDITED,
          payload: { words },
          taint: ["inferred"],
        })
      )
    }
    // The new slot list, for the review card and the next "Try another".
    if (applied.photos) {
      const photos = applied.photos
      await kit.withOrg({ orgId: ids.orgId }, (db) =>
        appendEvent(db, {
          orgId: ids.orgId,
          assignmentId: ids.assignmentId,
          staffId: spec.staff_id,
          type: "site.photos",
          payload: photos,
          taint: ["inferred"],
        })
      )
    }
    return {
      done: true,
      base,
      report_id: report.report_id,
      revision_id: tail.revisionId,
      model_ms: modelMs,
      attempts,
      timings: {
        check_ms: tail.check.ms,
        build_ms: tail.build.ms,
        upload_ms: tail.manifest.ms,
        upload_files: tail.manifest.files,
        upload_reused: tail.manifest.reused,
        upload_bytes: tail.manifest.bytes,
        source_ms: tail.source.ms,
        tool_ms: since(toolStarted),
        model_turns: attempts,
        reported_at: Date.now(),
      },
    }
  } catch (thrown) {
    // Whatever was written goes, so the next lane starts from the revision.
    if (base) {
      await sandbox
        .exec(`cd ${SITE_ROOT} && ${GIT} reset -q --hard ${base}`)
        .catch(() => undefined)
    }
    const reason =
      thrown instanceof Fell ? thrown.message : `error: ${message(thrown)}`
    return {
      done: false,
      reason: reason.slice(0, 1000),
      model_ms: modelMs || since(started),
    }
  }
}

const message = (thrown: unknown) =>
  thrown instanceof Error ? thrown.message : String(thrown)

/** The copy check's warnings in the build's output tail, at most five. */
export const copyFindings = (output: string) =>
  output
    .split("\n")
    .filter(
      (line) =>
        line.includes("[copy-check]") && !/finding\(s\)|clean/.test(line)
    )
    .map((line) => line.trim())
    .slice(0, 5)

/**
 * A `runtime.turn` row per call, the shape the budget and `turnCount` read
 * (`response.usage.cost.total`), so a quick edit is metered like a build.
 */
export async function logTurn(
  kit: Tenancy,
  ids: { orgId: string; assignmentId: string },
  staffId: string,
  role: string,
  reply: { usage: unknown; model: string }
) {
  await kit.withOrg({ orgId: ids.orgId }, (db) =>
    appendEvent(db, {
      orgId: ids.orgId,
      assignmentId: ids.assignmentId,
      staffId,
      type: "runtime.turn",
      payload: { role, model: reply.model, response: { usage: reply.usage } },
    })
  )
}
