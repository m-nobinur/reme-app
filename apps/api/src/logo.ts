import {
  type Asset,
  DrawLogosRequest,
  idempotencyKey,
  type KeptLogo,
  LOGO_ROUND_WAITS,
  LOGO_ROUNDS_MAX,
  LOGO_VARIANTS,
  type LogoBrief,
  type LogoRound,
  type LogoRounds,
  type LogoStyle,
} from "@workspace/contracts"
import type { Tenancy } from "@workspace/db"
import { generateText, Output } from "ai"
import {
  editUploads,
  findGenerated,
  LOGO_VARIANT,
  sniff,
  stableId,
  uploadKey,
} from "./assets.ts"
import type { Owner } from "./changes.ts"
import { failure, invalid, keyMissing, readBody, sha256Hex } from "./http.ts"
import { logoReference } from "./logo-references.ts"
import {
  changesPrompt,
  DIRECTOR_GUIDE,
  type LogoSubject,
  logoPrompt,
  variantStyles,
} from "./logo-style.ts"
import { factValue } from "./onboarding.ts"
import { DEFAULT_ONBOARDING_MODEL, plannerModel } from "./onboarding-agent.ts"
import { readFacts } from "./workspace.ts"

/**
 * The logo maker. `POST /logos` starts a round of four variants for one
 * design tray's logo question and answers 202 at once; the drawing runs in
 * the api's own queue consumer (`after-turn.ts` hands it `LogoJob`s), which
 * has fifteen minutes where `waitUntil` has thirty seconds. The round's
 * truth is a manifest in R2 beside the pictures, so a reload re-reads
 * `GET /logos` and loses nothing, and a consumer that died leaves a round
 * that reads `failed` once its deadline passes, for the owner to try again.
 *
 * The owner picks the logo type, so a round's four variants share it and
 * differ by idea: a first round asks the director, one quick text call, for
 * four ideas for that type first, and for one colour a second to go with it.
 * Each variant is handed the example picture for its type and style
 * (`logo-references.ts`) to take its layout and look from; the model draws
 * all the lettering itself. A round of changes to a picked variant hands the
 * image model that picture instead. A variant is one call, so one
 * failure loses one tile, not all. Every variant is a PNG on a transparent
 * background; the bytes are checked, not the model's word for it.
 *
 * Rounds are paced by `LOGO_ROUND_WAITS`: each waits that long after the
 * one before it finished, which is why the manifest records a finish time.
 *
 * Measured 2026-10-23, four calls in parallel: GPT Image 2.5 Sunburst
 * (medium, transparent) took 17 to 18 s a call and 19 s a round, $0.0133 a
 * logo and $0.053 a round, 1024 px PNGs of 0.6 to 0.9 MB. Its Flare tier
 * answered the same request in 10 s at the same price, also with alpha. The
 * director (Gemini 3.8 Flash) took 4.8 s and $0.0016. With an example attached
 * to each call, measured the same day: 23 to 24 s and $0.069 a round.
 */

/**
 * Tried in order for each variant. Seedream, the old fallback, cannot draw a
 * transparent background. Of the live image models only the GPT Image family
 * took one when probed on 2026-10-23 (2.5 Flare, 1 and 1 mini answered with
 * alpha, 2 refused the request), so the fallback is Flare, the other tier of
 * the same family.
 */
export const LOGO_MODELS = [
  {
    id: "openai/gpt-image-2.5-sunburst",
    options: { quality: "medium", background: "transparent" },
    ms: 75_000,
  },
  {
    id: "openai/gpt-image-2.5-flare",
    options: { quality: "medium", background: "transparent" },
    ms: 75_000,
  },
] as const

/**
 * A round still drawing after this reads `failed`. The slowest honest path
 * is a five-second queue wait, the director's six, then a variant whose
 * first model times out and whose second takes its full time: under three
 * minutes.
 */
export const DRAW_DEADLINE_MS = 4 * 60_000

/** The director's limit; past it the variants are drawn without its ideas. */
const DIRECTOR_MS = 6_000

/**
 * The rounds one org may start in a UTC day, counting tries after a failure.
 * Twenty: one logo question allows ten, and an owner who starts onboarding
 * again or asks for a logo later has room for another question's worth. At
 * $0.069 a round that bounds a day at about $1.38 of drawing, well under the
 * org's daily model cap.
 */
export const LOGO_ROUNDS_PER_DAY = 20

/** Calls started 350 ms apart, as logocreator does, so four do not land at once. */
const STAGGER_MS = 350

/** What the queue carries: names only, the manifest holds the rest. */
export type LogoJob = {
  kind: "logo"
  orgId: string
  toolCallId: string
  round: number
}

type Manifest = {
  round: number
  status: LogoRound["status"]
  /** The request's Idempotency-Key: a retry replays this round, a new try replaces a failed one. */
  key: string
  started_at: string
  /** When the round became ready or failed; absent while drawing. */
  finished_at?: string
  subject: LogoSubject & { offerings: string[] }
  brief: LogoBrief
  changes?: string
  base?: string
  /** The four ids the round draws, in the order the tiles show them. */
  planned: string[]
  /** The style each planned variant is drawn in: one, or four for `surprise`. */
  styles: LogoStyle[]
  /** The ones drawn so far. */
  variants: string[]
}

const manifestPrefix = (orgId: string, toolCallId: string) =>
  `logos/${orgId}/${encodeURIComponent(toolCallId)}/`
const manifestKey = (orgId: string, toolCallId: string, round: number) =>
  `${manifestPrefix(orgId, toolCallId)}${round}.json`
const variantKey = (orgId: string, id: string, ext: string) =>
  `generated/${orgId}/${id}.${ext}`

const EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/webp": "webp",
  "image/jpeg": "jpg",
}

/** The round as the owner sees it: a round drawing past its deadline is over. */
export function roundView(manifest: Manifest, now = Date.now()): LogoRound {
  const lapsed =
    manifest.status === "drawing" &&
    now - Date.parse(manifest.started_at) > DRAW_DEADLINE_MS
  const status = lapsed
    ? manifest.variants.length > 0
      ? "ready"
      : "failed"
    : manifest.status
  return {
    round: manifest.round,
    status,
    variants: manifest.variants.map((id) => ({ id })),
  }
}

/** Seconds round `round` waits after the one before it finished; the last wait repeats. */
export const waitBefore = (round: number) =>
  LOGO_ROUND_WAITS[Math.min(round, LOGO_ROUND_WAITS.length) - 1] as number

/** A round that lapsed with no finish time is taken to have ended at its deadline. */
const finishedAt = (m: Manifest) =>
  m.finished_at
    ? Date.parse(m.finished_at)
    : Date.parse(m.started_at) + DRAW_DEADLINE_MS

/**
 * When the next round may start, in epoch ms, as `LogoRounds.next_at` has
 * it: null when it may now or one is drawing (a failed round is replaced at
 * once, so it waits for nothing), undefined once `LOGO_ROUNDS_MAX` are drawn.
 */
export function nextRoundAt(
  rounds: readonly Manifest[],
  now = Date.now()
): number | null | undefined {
  const latest = rounds.at(-1)
  if (!latest || roundView(latest, now).status !== "ready") return null
  if (latest.round >= LOGO_ROUNDS_MAX) return undefined
  const at = finishedAt(latest) + waitBefore(latest.round + 1) * 1000
  return at > now ? at : null
}

/** A wait in plain words, rounded up: "a minute", "5 minutes", "an hour", "24 hours". */
const inWords = (seconds: number) => {
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return minutes === 1 ? "a minute" : `${minutes} minutes`
  const hours = Math.ceil(minutes / 60)
  return hours === 1 ? "an hour" : `${hours} hours`
}

type Stored = { manifest: Manifest; etag: string }

async function readRounds(
  env: Env,
  orgId: string,
  toolCallId: string
): Promise<Stored[]> {
  const listed = await env.SITES.list({
    prefix: manifestPrefix(orgId, toolCallId),
  })
  const rounds = await Promise.all(
    listed.objects.map(async ({ key }) => {
      const object = await env.SITES.get(key)
      return object
        ? { manifest: await object.json<Manifest>(), etag: object.etag }
        : null
    })
  )
  return rounds
    .filter((r): r is Stored => r !== null)
    .sort((a, b) => a.manifest.round - b.manifest.round)
}

const refused = (status: number, code: string, message: string) =>
  failure(status, { class: "validation", code, message, detail: {} })

/**
 * Counts one more use of a daily allowance, keyed under `prefix` for the
 * UTC day, or answers false when `cap` are already used. One empty marker
 * object a use, so two at once never lose a count.
 *
 * shortcut: two requests at the same instant can both pass at cap - 1; a
 * counter in Postgres if that ever matters at these numbers.
 */
export async function useDaily(
  env: Env,
  prefix: string,
  cap: number,
  marker: string
): Promise<boolean> {
  const day = `${prefix}/${new Date().toISOString().slice(0, 10)}/`
  const used = await env.SITES.list({ prefix: day, limit: cap })
  if (used.objects.length >= cap) return false
  await env.SITES.put(`${day}${await sha256Hex(marker)}`, "")
  return true
}

const ToolCallId = DrawLogosRequest.shape.tool_call_id

/** `POST /logos`: starts a round, or replays the one this key or a drawing round already is. */
export async function drawLogos(
  request: Request,
  env: Env,
  kit: Tenancy,
  owner: Owner
): Promise<Response> {
  const key = idempotencyKey(request)
  if (!key) return keyMissing()
  const parsed = DrawLogosRequest.safeParse(await readBody(request))
  if (!parsed.success) return invalid(parsed.error.issues)
  const { tool_call_id: toolCallId, brief, changes, base } = parsed.data
  if (base && !changes) return invalid([{ path: ["changes"] }])
  if (!env.OPENROUTER_API_KEY) {
    return failure(503, {
      class: "transient",
      code: "logos.unavailable",
      message:
        "The logo maker isn't available right now. Upload your logo instead.",
      detail: {},
    })
  }
  const orgId = owner.orgId
  const rounds = await readRounds(env, orgId, toolCallId)
  const started = (stored: Stored) =>
    Response.json(roundView(stored.manifest), { status: 202 })
  const replay = rounds.find((r) => r.manifest.key === key)
  if (replay) return started(replay)
  const latest = rounds.at(-1)
  const view = latest && roundView(latest.manifest)
  // One round at a time: a second click while one draws gets that one.
  if (latest && view?.status === "drawing") return started(latest)
  // A round that drew nothing is tried again in its own place.
  const retry = view?.status === "failed" ? latest : undefined
  const round = retry ? retry.manifest.round : rounds.length + 1
  if (round > LOGO_ROUNDS_MAX) {
    return refused(
      409,
      "logos.rounds",
      "That's as many tries as one logo gets. Pick the one you like best, or upload your own."
    )
  }
  if (base && !rounds.some((r) => r.manifest.variants.includes(base))) {
    return invalid([{ path: ["base"] }])
  }
  // A new try after a failed round replaces it and waits for nothing.
  const now = Date.now()
  const opens = retry
    ? null
    : nextRoundAt(
        rounds.map((r) => r.manifest),
        now
      )
  if (opens) {
    const seconds = Math.ceil((opens - now) / 1000)
    const response = failure(429, {
      class: "transient",
      code: "logos.wait",
      message: `Your next round opens in ${inWords(seconds)}. Until then, pick the logo you like best.`,
      detail: {},
    })
    response.headers.set("retry-after", String(seconds))
    return response
  }

  const facts = await kit.withOrg({ orgId }, readFacts)
  const name = factValue(facts, "business.name")?.name
  if (!name) {
    return refused(
      409,
      "logos.no_name",
      "Tell me your business name first, so the logo can carry it."
    )
  }
  const allowed = await useDaily(
    env,
    `logo-days/${orgId}`,
    LOGO_ROUNDS_PER_DAY,
    `${toolCallId}:${round}:${key}`
  )
  if (!allowed) {
    const response = failure(429, {
      class: "transient",
      code: "logos.daily_cap",
      message:
        "That's a lot of logos for one day. Pick one you like, or try again tomorrow.",
      detail: {},
    })
    response.headers.set("retry-after", "3600")
    return response
  }

  const manifest: Manifest = {
    round,
    status: "drawing",
    key,
    started_at: new Date().toISOString(),
    subject: {
      name,
      trade: factValue(facts, "business.industry")?.name ?? "service",
      offerings: factValue(facts, "business.offerings")?.items ?? [],
    },
    brief,
    ...(changes ? { changes } : {}),
    ...(base ? { base } : {}),
    // The key is in the seed, so a try that replaces a failed round never
    // shares an id with a late picture from the one before.
    planned: await Promise.all(
      Array.from({ length: LOGO_VARIANTS }, (_, i) =>
        stableId(`${orgId}:${toolCallId}:${round}:${key}:${i}`)
      )
    ),
    styles: variantStyles(brief.style),
    variants: [],
  }
  const at = manifestKey(orgId, toolCallId, round)
  const written = await env.SITES.put(at, JSON.stringify(manifest), {
    onlyIf: retry
      ? { etagMatches: retry.etag }
      : new Headers({ "if-none-match": "*" }),
  })
  if (!written) {
    // Another request took this round first: answer with the one it started.
    const winner = (await readRounds(env, orgId, toolCallId)).find(
      (r) => r.manifest.round === round
    )
    if (winner) return started(winner)
    return failure(409, {
      class: "transient",
      code: "logos.busy",
      message: "Something changed while starting. Try again.",
      detail: {},
    })
  }
  const job: LogoJob = { kind: "logo", orgId, toolCallId, round }
  try {
    await env.AFTER_TURN.send(job)
  } catch {
    await env.SITES.put(at, JSON.stringify({ ...manifest, status: "failed" }))
    return failure(503, {
      class: "transient",
      code: "logos.not_started",
      message: "I couldn't start the drawing. Try again.",
      detail: {},
    })
  }
  return Response.json(roundView(manifest), { status: 202 })
}

/** `GET /logos?tool_call_id=`: every round of that question, oldest first, and when the next may start. */
export async function readLogos(
  request: Request,
  env: Env,
  owner: Owner
): Promise<Response> {
  const toolCallId = ToolCallId.safeParse(
    new URL(request.url).searchParams.get("tool_call_id")
  )
  if (!toolCallId.success) return invalid([{ path: ["tool_call_id"] }])
  const rounds = await readRounds(env, owner.orgId, toolCallId.data)
  const opens = nextRoundAt(rounds.map((r) => r.manifest))
  const body: LogoRounds = {
    rounds: rounds.map((r) => roundView(r.manifest)),
    ...(opens === undefined
      ? {}
      : { next_at: opens === null ? null : new Date(opens).toISOString() }),
  }
  return Response.json(body, { headers: { "cache-control": "no-store" } })
}

/**
 * `POST /logos/{id}/keep`: a drawn variant is copied to the org's uploads;
 * an uploaded asset is marked as it is. Either way it becomes the one item
 * in `media.uploads` with `use` "logo", and an earlier logo leaves the list.
 */
export async function keepLogo(
  request: Request,
  env: Env,
  kit: Tenancy,
  owner: Owner,
  id: string
): Promise<Response> {
  if (!idempotencyKey(request)) return keyMissing()
  const orgId = owner.orgId
  const facts = await kit.withOrg({ orgId }, readFacts)
  const uploaded = factValue(facts, "media.uploads")?.items.find(
    (a) => a.id === id
  )
  let asset: Asset
  if (uploaded) {
    asset = { ...uploaded, use: "logo" }
  } else {
    const variant = await findGenerated(env, orgId, id)
    if (variant?.customMetadata?.use !== LOGO_VARIANT.use) {
      await variant?.body.cancel()
      return failure(404, {
        class: "resource",
        code: "logo.not_found",
        message: "That logo isn't here any more. Pick another one.",
        detail: {},
      })
    }
    const bytes = new Uint8Array(await variant.arrayBuffer())
    const kind = sniff(bytes)
    if (!kind) throw new Error("logos.variant_type")
    await env.SITES.put(uploadKey(orgId, id), bytes, {
      httpMetadata: { contentType: kind },
    })
    asset = {
      id,
      name: `Logo.${EXTENSION[kind]}`,
      content_type: kind,
      bytes: bytes.byteLength,
      use: "logo",
    }
  }
  const stored = await editUploads(kit, owner, (items) => [
    ...items.filter((a) => a.id !== id && a.use !== "logo"),
    asset,
  ])
  if (!stored) {
    return refused(
      409,
      "assets.too_many",
      "That's as many pictures as a business can keep. Remove a photo first."
    )
  }
  const body: KeptLogo = { asset }
  return Response.json(body)
}

// --- The drawing, in the queue consumer -------------------------------------

/**
 * The director: up to four ideas for the logo type, and for an owner who gave
 * one colour a supporting one, or null when it is slow or says nothing usable.
 */
export type Director = (
  subject: Manifest["subject"],
  brief: LogoBrief
) => Promise<{ ideas: string[]; support?: string } | null>

function openrouterDirector(apiKey: string, modelId: string): Director | null {
  const model = plannerModel(apiKey, modelId)
  if (!model) return null
  return async (subject, brief) => {
    const data = JSON.stringify({
      ...subject,
      type: brief.type,
      direction: brief.description,
      style: brief.style,
      colors: brief.colors,
    }).replace(/</g, "\\u003c")
    const result = await generateText({
      model,
      system: DIRECTOR_GUIDE,
      prompt: `<data source="onboarding" taint="untrusted_input">\n${data}\n</data>`,
      output: Output.json(),
      // Reasoning tokens count against this: 400 cut the answer off when measured.
      maxOutputTokens: 1_500,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(DIRECTOR_MS),
    })
    const support = supportOf(result.output)
    return { ideas: symbolsOf(result.output), ...(support ? { support } : {}) }
  }
}

/** The director's supporting colour: a `#rrggbb` hex, or nothing. */
export function supportOf(value: unknown): string | undefined {
  const support = (value as { support?: unknown } | null)?.support
  return typeof support === "string" && /^#[0-9a-f]{6}$/i.test(support.trim())
    ? support.trim().toLowerCase()
    : undefined
}

/** The director's answer: its ideas that are words, each short, at most one per variant. */
export function symbolsOf(value: unknown): string[] {
  const ideas = (value as { ideas?: unknown } | null)?.ideas
  if (!Array.isArray(ideas)) return []
  return ideas
    .filter((idea): idea is string => typeof idea === "string" && !!idea.trim())
    .map((idea) => idea.trim().slice(0, 160))
    .slice(0, LOGO_VARIANTS)
}

/**
 * Whether PNG bytes carry alpha: a colour type with an alpha channel, or a
 * tRNS chunk ahead of the pixels. The model's word that it drew a
 * transparent background is not taken.
 */
export function hasAlpha(bytes: Uint8Array): boolean {
  if (sniff(bytes) !== "image/png" || bytes.length < 26) return false
  if (bytes[25] === 4 || bytes[25] === 6) return true
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let at = 8; at + 8 <= bytes.length; at += 12 + view.getUint32(at)) {
    const name = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
    if (name === "tRNS") return true
    if (name === "IDAT") return false
  }
  return false
}

type Drawn = { bytes: Uint8Array; type: string; cost: number }

/** One picture from one model, its bytes checked to be a PNG with alpha. */
async function drawOne(
  apiKey: string,
  model: (typeof LOGO_MODELS)[number],
  prompt: string,
  reference: string | null
): Promise<Drawn> {
  const response = await fetch("https://openrouter.ai/api/v1/images", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: model.id,
      prompt,
      n: 1,
      aspect_ratio: "1:1",
      ...model.options,
      ...(reference
        ? {
            input_references: [
              { type: "image_url", image_url: { url: reference } },
            ],
          }
        : {}),
    }),
    signal: AbortSignal.timeout(model.ms),
  })
  if (!response.ok) throw new Error(`logos.http_${response.status}`)
  const body = (await response.json()) as {
    data?: { b64_json?: string }[]
    usage?: { cost?: number }
  }
  const b64 = body.data?.[0]?.b64_json
  if (!b64) throw new Error("logos.empty")
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const type = sniff(bytes)
  if (!type) throw new Error("logos.not_an_image")
  if (!hasAlpha(bytes)) throw new Error("logos.opaque")
  return { bytes, type, cost: Number(body.usage?.cost ?? 0) }
}

const dataUrl = (bytes: Uint8Array, type: string) => {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return `data:${type};base64,${btoa(binary)}`
}

/**
 * Draws one round for the queue. A variant already in R2 is skipped, so a
 * retried message finishes the round rather than paying for it twice. A
 * round no longer drawing, past its deadline, or replaced by a new try is
 * left alone. Throws only on a storage failure, for the queue to retry.
 */
export async function drawRound(
  env: Env,
  job: LogoJob,
  deps: { director?: Director | null } = {}
): Promise<void> {
  const began = Date.now()
  const apiKey = env.OPENROUTER_API_KEY
  const at = manifestKey(job.orgId, job.toolCallId, job.round)
  const first = await env.SITES.get(at)
  const manifest = first && (await first.json<Manifest>())
  if (!apiKey || !manifest || roundView(manifest).status !== "drawing") return

  // Each finished variant is written in turn, one write at a time, and only
  // while the manifest is still this try's.
  let writes = Promise.resolve()
  const record = (change: (m: Manifest) => Manifest) => {
    writes = writes.then(async () => {
      const now = await env.SITES.get(at)
      const current = now && (await now.json<Manifest>())
      if (current?.key !== manifest.key || current.status !== "drawing") return
      await env.SITES.put(at, JSON.stringify(change(current)))
    })
    return writes
  }
  const add = (id: string) =>
    record((m) =>
      m.variants.includes(id) ? m : { ...m, variants: [...m.variants, id] }
    )
  const exists = async (id: string) =>
    (
      await Promise.all(
        Object.values(EXTENSION).map((ext) =>
          env.SITES.head(variantKey(job.orgId, id, ext))
        )
      )
    ).some(Boolean)

  // A round of changes hands over the picked variant. Any other round hands
  // each variant the example for its type and style, set per variant below.
  let base: string | null = null
  if (manifest.base) {
    const picked = await findGenerated(env, job.orgId, manifest.base)
    if (picked) {
      const bytes = new Uint8Array(await picked.arrayBuffer())
      base = dataUrl(bytes, sniff(bytes) ?? "image/png")
    }
  }
  const exampleFor = (style: LogoStyle) =>
    dataUrl(logoReference(manifest.brief.type, style), "image/webp")
  const director =
    deps.director !== undefined
      ? deps.director
      : openrouterDirector(
          apiKey,
          env.ONBOARDING_MODEL ?? DEFAULT_ONBOARDING_MODEL
        )
  const directed =
    base || !director
      ? null
      : await director(manifest.subject, manifest.brief).catch(() => null)
  const symbols = directed?.ideas ?? []
  // A second colour only for an owner who gave one.
  const support =
    manifest.brief.colors.length === 1 ? directed?.support : undefined

  const outcomes = await Promise.all(
    manifest.planned.map(async (id, i) => {
      if (manifest.variants.includes(id) || (await exists(id))) {
        await add(id)
        return { model: "kept", cost: 0 }
      }
      await new Promise((resolve) => setTimeout(resolve, i * STAGGER_MS))
      const style = manifest.styles[i] as LogoStyle
      const asked = manifest.changes && base
      const reference = base ?? exampleFor(style)
      for (const model of LOGO_MODELS) {
        const prompt = asked
          ? changesPrompt({
              subject: manifest.subject,
              brief: manifest.brief,
              changes: manifest.changes as string,
            })
          : logoPrompt({
              subject: manifest.subject,
              brief: manifest.brief,
              style,
              symbol: symbols[i] ?? null,
              support,
              reference: !base,
              changes: manifest.changes,
            })
        const drawn = await drawOne(apiKey, model, prompt, reference).catch(
          (error: unknown) => {
            console.error(
              JSON.stringify({
                code: "logos.draw_failed",
                model: model.id,
                error: error instanceof Error ? error.message : "unknown",
              })
            )
            return null
          }
        )
        if (!drawn) continue
        await env.SITES.put(
          variantKey(job.orgId, id, EXTENSION[drawn.type] as string),
          drawn.bytes,
          {
            httpMetadata: { contentType: drawn.type },
            customMetadata: LOGO_VARIANT,
          }
        )
        await add(id)
        return { model: model.id, cost: drawn.cost }
      }
      return { model: null, cost: 0 }
    })
  )
  const drawn = outcomes.filter((o) => o.model !== null).length
  await record((m) => ({
    ...m,
    // Tiles in planned order, whatever order they finished in.
    variants: m.planned.filter((id) => m.variants.includes(id)),
    status: drawn > 0 ? "ready" : "failed",
    finished_at: new Date().toISOString(),
  }))
  console.log(
    JSON.stringify({
      code: "logos.round",
      round: job.round,
      drawn,
      models: outcomes.map((o) => o.model),
      ms: Date.now() - began,
      cost_usd: outcomes.reduce((sum, o) => sum + o.cost, 0),
    })
  )
}

/** A queue message that is a logo round rather than a closed turn. */
export const isLogoJob = (body: unknown): body is LogoJob =>
  typeof body === "object" &&
  body !== null &&
  (body as { kind?: unknown }).kind === "logo"

/** One logo message: acked when drawn, retried on a storage failure, then the dead-letter queue. */
export async function drawLogoMessage(
  env: Env,
  message: Message<LogoJob>
): Promise<void> {
  try {
    await drawRound(env, message.body)
    message.ack()
  } catch (error) {
    console.error(
      JSON.stringify({
        code: "logos.round_failed",
        attempts: message.attempts,
        error: error instanceof Error ? error.message : "unknown",
      })
    )
    message.retry()
  }
}
