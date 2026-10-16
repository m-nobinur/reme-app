import { limit } from "@workspace/gates"
import {
  fieldsOfPrompt,
  pageCheck,
  pageOfPrompt,
  type WriterTask,
} from "./fanout.ts"
import { generatedPath } from "./images.ts"
import type { PhotoFile } from "./photo-step.ts"
import { SITE_ROOT } from "./revise.ts"

/**
 * The first build's pages in code, not in the lead's turns (`write_pages`).
 * In the confirming run of 2026-10-15 the lead sent the five main pages one
 * after another (its checkpoint call rode in the same batch, and one
 * sequential tool runs a whole batch in order), 95 s where the four service
 * pages took 28 s at once; photos took 89 s before any page started; and the
 * lead's first build spent 82.6 s encoding them, where its later builds took
 * 2.7 s. So: every writer is one model call, run here several at once; the
 * photos draw meanwhile and land in the site as each is made; and Astro's
 * image cache is filled in the background, so the lead's build reuses it.
 */

/** A writer's reply: its summary and the new text of each field it owns. */
export type Reply = { summary: string; values: Record<string, string> }

/** The reply's shape for structured output: exactly the task's own fields. */
export function replySchema(fields: readonly string[]) {
  const text = { type: "string" }
  return {
    name: "page_fields",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "values"],
      properties: {
        summary: text,
        values: {
          type: "object",
          additionalProperties: false,
          required: [...fields],
          properties: Object.fromEntries(fields.map((f) => [f, text])),
        },
      },
    },
  }
}

/** The reply as JSON, kept to the task's own string fields; throws a message the retry can read. */
export function parseReply(text: string, fields: readonly string[]): Reply {
  // A reply may wrap its JSON in a fence; the object is what counts.
  let raw: { summary?: unknown; values?: unknown }
  try {
    raw = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1))
  } catch {
    throw new Error("The reply was not JSON. Reply with the JSON object only.")
  }
  const given = (raw.values ?? {}) as Record<string, unknown>
  const values = Object.fromEntries(
    fields.flatMap((f) => (typeof given[f] === "string" ? [[f, given[f]]] : []))
  )
  if (Object.keys(values).length === 0 && fields.length > 0) {
    throw new Error(
      `The reply had no values for your fields: ${fields.join(", ")}.`
    )
  }
  return { summary: String(raw.summary ?? "").slice(0, 400), values }
}

/** A field's line in the site config's values, `  name: "…"`, wrapped or not. */
const fieldLine = (field: string) =>
  new RegExp(`^( {2}${field}:\\s*)"(?:[^"\\\\\\n]|\\\\.)*"`, "m")

/** Each field's current line with the note above it, which is what a writer reads before it writes. */
export function fieldLines(source: string, fields: readonly string[]): string {
  const lines = source.split("\n")
  return fields
    .flatMap((field) => {
      const at = lines.findIndex((l) => l.startsWith(`  ${field}:`))
      if (at < 0) return []
      let from = at
      if (lines[at - 1]?.trim().endsWith("*/")) {
        from = at - 1
        while (from > 0 && !lines[from]?.trim().startsWith("/**")) from--
      }
      // A value wrapped to the next line comes with it.
      const to = /:\s*$/.test(lines[at] ?? "") ? at + 1 : at
      return [lines.slice(from, to + 1).join("\n")]
    })
    .join("\n")
}

/** The site config with each value written into its own field's line. A field it cannot find is left alone. */
export function setValues(
  source: string,
  values: Record<string, string>
): string {
  let next = source
  for (const [field, value] of Object.entries(values)) {
    next = next.replace(
      fieldLine(field),
      (_, head: string) => `${head}${JSON.stringify(value)}`
    )
  }
  return next
}

/** What a writer reads after its instructions: the task, then its lines as they are. */
export const writerUser = (prompt: string, source: string) =>
  [
    prompt,
    "",
    "<fields>",
    fieldLines(source, fieldsOfPrompt(prompt)),
    "</fields>",
  ].join("\n")

/** A writer's name in the lead's lines: the page, the service's number, or the copy writer. */
const label = (prompt: string) =>
  `${pageOfPrompt(prompt) ?? "copy"}${/^Page service\. Service (\d)/.exec(prompt)?.[1] ?? ""}`

const message = (thrown: unknown) =>
  thrown instanceof Error ? thrown.message : String(thrown)

/** A `pageCheck` message's findings on one line. */
const findings = (check: string) =>
  check
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2))
    .join("; ")

/**
 * Every writer, at most `max` at once. The first call goes alone for
 * `staggerMs` so its siblings, which share its instructions, read the cache
 * entry it writes rather than each paying for its own. A task with `after`
 * waits for that task. Each writer's fields go through the copy gate's field
 * check once, and a finding gets one more call. One line per writer back,
 * for the lead; a writer that fails says so, and its fields are the lead's.
 *
 * shortcut: the stagger is a fixed wait, not the first token (the call does
 * not stream); move to the facade's prefix warmer if writers move to it.
 */
export async function writePages(input: {
  tasks: readonly WriterTask[]
  max: number
  staggerMs: number
  /**
   * One model call; `attempt` 2 is the retry or the check's fix. `strict`
   * asks for the reply schema, which only the retry after an unparsable
   * reply does: in the paid check of 2026-10-16 every strict call missed the
   * writers' shared prompt cache (a service writer $0.068 strict, $0.018
   * without), and every reply without it parsed in full.
   */
  call: (
    index: number,
    attempt: 1 | 2,
    user: string,
    strict: boolean
  ) => Promise<string>
  /** Read, change and write the site config, one change at a time. */
  edit: (change: (source: string) => string) => Promise<string>
  onWritten?: (task: WriterTask) => void
  sleep?: (ms: number) => Promise<void>
}): Promise<string[]> {
  const { tasks, call, edit } = input
  const sleep =
    input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const run = async (index: number): Promise<string> => {
    const task = tasks[index] as WriterTask
    const fields = fieldsOfPrompt(task.prompt)
    const name = label(task.prompt)
    try {
      const user = writerUser(task.prompt, await edit((s) => s))
      let second = false
      let reply: Reply
      try {
        reply = parseReply(await call(index, 1, user, false), fields)
      } catch (thrown) {
        second = true
        reply = parseReply(
          await call(
            index,
            2,
            `${user}\n<previous_reply_failed>\n${message(thrown)}\n</previous_reply_failed>`,
            true
          ),
          fields
        )
      }
      const written = await edit((s) => setValues(s, reply.values))
      const check = second ? null : pageCheck(written, task.prompt)
      let note = ""
      if (check) {
        try {
          const fixed = parseReply(
            await call(
              index,
              2,
              `${user}\n<your_reply>\n${JSON.stringify(reply.values)}\n</your_reply>\n${check}`,
              false
            ),
            fields
          )
          await edit((s) => setValues(s, fixed.values))
          reply = { ...fixed, summary: fixed.summary || reply.summary }
          const left = pageCheck(await edit((s) => s), task.prompt)
          note = left
            ? ` Still failing the copy check: ${findings(left)}`
            : " Fixed what the copy check found."
        } catch (thrown) {
          note = ` Its fix failed (${message(thrown).slice(0, 120)}); the copy check still finds: ${findings(check)}`
        }
      }
      input.onWritten?.(task)
      return `- ${name}: ${reply.summary}${note}`
    } catch (thrown) {
      return `- ${name}: failed (${message(thrown).slice(0, 160)}). Its fields are yours: ${fields.join(", ")}.`
    }
  }
  const bounded = limit(input.max)
  const done: Promise<string>[] = []
  tasks.forEach((task, index) => {
    const first = done[0]
    const gate =
      first === undefined
        ? Promise.resolve()
        : Promise.race([sleep(input.staggerMs), first])
    const before = task.after === undefined ? undefined : done[task.after]
    done[index] = gate.then(() => before).then(() => bounded(() => run(index)))
  })
  return Promise.all(done)
}

/** What the photo step has said so far: slots made, and the final list once it is done. */
export type Landed = { files: PhotoFile[]; settled: PhotoFile[] | null }

/**
 * The photo step's events, in log order, as `followPhotos` reads them: each
 * progress row with a key is a slot made; `site.photos` is the final list;
 * `site.photos_failed`, which the Workflow writes when the step throws,
 * settles it with what had landed, so nothing waits on a step that is over.
 */
export function landedOf(
  rows: readonly { type: string; payload: Record<string, unknown> }[]
): Landed {
  const files = rows
    .filter((r) => r.type === "build.progress" && r.payload.key)
    .map(
      ({ payload: p }): PhotoFile => ({
        slot_id: String(p.item),
        status: p.status as PhotoFile["status"],
        key: p.key as string,
        content_type: (p.content_type as string | null) ?? null,
      })
    )
    .filter((f) => f.status !== "fallback")
  const done = rows.find((r) => r.type === "site.photos")
  const failed = rows.some((r) => r.type === "site.photos_failed")
  return {
    files,
    settled: done
      ? ((done.payload.step as { files?: PhotoFile[] } | undefined)?.files ??
        [])
      : failed
        ? files
        : null,
  }
}

/**
 * The plan's generated photos into the site as each is made, while the
 * pages are written: polls `landed`, places what is new, and returns the
 * final list once the step settles, or what landed by `timeoutMs`. A slot
 * redrawn on a retry has a new key and is placed again.
 */
export async function followPhotos(input: {
  slots: readonly string[]
  landed: () => Promise<Landed>
  place: (files: PhotoFile[]) => Promise<unknown>
  onPlaced?: () => void
  pollMs: number
  timeoutMs: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}): Promise<{ files: PhotoFile[]; timedOut: boolean }> {
  if (input.slots.length === 0) return { files: [], timedOut: false }
  const sleep =
    input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const now = input.now ?? Date.now
  const placed = new Map<string, PhotoFile>()
  const placeNew = async (files: PhotoFile[]) => {
    const fresh = files.filter(
      (f) => f.key && placed.get(f.slot_id)?.key !== f.key
    )
    if (fresh.length === 0) return
    await input.place(fresh)
    for (const f of fresh) placed.set(f.slot_id, f)
    input.onPlaced?.()
  }
  const deadline = now() + input.timeoutMs
  for (;;) {
    const { files, settled } = await input.landed()
    if (settled) {
      await placeNew(settled)
      return { files: settled, timedOut: false }
    }
    await placeNew(files)
    if (now() >= deadline)
      return { files: [...placed.values()], timedOut: true }
    await sleep(input.pollMs)
  }
}

/**
 * Each generated slot's path in the site config as it landed: the writers
 * wrote the planned `.jpg`, a draw may be another format, and a slot that
 * fell back or never came leaves its field empty, so its section takes the
 * no-image form.
 */
export function reconcilePhotos(
  source: string,
  slots: readonly string[],
  files: readonly PhotoFile[]
): string {
  let next = source
  for (const slot of slots) {
    const file = files.find((f) => f.slot_id === slot && f.key)
    const to = file ? generatedPath(slot, file.content_type) : ""
    next = next.replace(
      new RegExp(`"src/assets/generated/${slot}\\.(?:jpe?g|png|webp)"`, "g"),
      JSON.stringify(to)
    )
  }
  return next
}

/**
 * A build of the site as it stands, for its image cache: Astro keys an
 * encoded image by the photo's path, size, format and quality, never the
 * page, so the lead's own build reuses every one. Into the site's own dist,
 * which the lead's build replaces: Astro renames assets into the output
 * directory, and an outDir under /tmp fails with EXDEV in the sandbox image.
 * Its result does not matter.
 */
export const WARM_BUILD = `cd ${SITE_ROOT} && timeout 300 ./node_modules/.bin/astro build > /tmp/reme-warm.log 2>&1; true`

/**
 * Runs `build` again while there is something new for it, never two at once
 * (two builds writing one cache would each encode the same photo).
 */
export function createWarmer(build: () => Promise<unknown>) {
  let running: Promise<void> | null = null
  let again = false
  const loop = async () => {
    do {
      again = false
      await build().catch(() => undefined)
    } while (again)
    running = null
  }
  return {
    kick() {
      if (running) again = true
      else running = loop()
    },
    /** Settles when no build is running or asked for. */
    idle: () => running ?? Promise.resolve(),
  }
}
