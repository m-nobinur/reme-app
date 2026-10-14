import type { Blueprint, ImageSlot } from "@workspace/contracts"
import { MODELS, ROLES } from "@workspace/facade"
import { generatedImageFindings, limit } from "@workspace/gates"
import { z } from "zod"
import { photoKey, SITE_ROOT } from "./revise.ts"

/**
 * The photo director (ADR-039). Runs in this Worker, never in the sandbox,
 * whose egress is the npm registry only and which holds no key (ADR-031).
 * One Haiku call writes the prompts, a chain of image models draws each slot
 * through OpenRouter's images endpoint (`QUALITY_MODELS` for the hero,
 * `FAST_MODELS` for the rest), and the bytes land in the site bucket under
 * `generated/{org}/{id}.{ext}`. A build never fails for a photo: every slot
 * that cannot be filled comes back `fallback` and the section takes its
 * no-image variant.
 *
 * There is no asset table. The id is a hash of what the picture is, so the
 * key is the lookup (reuse), the R2 object carries model, prompt hash and
 * cost as metadata, and the day's generations are the objects uploaded today.
 *
 * ponytail: the daily count lists R2 and reads `uploaded`, so it is eventually
 * consistent and counts only photos that were kept. A counter row in
 * `packages/db` once a second Worker generates for the same org.
 */

type PhotoModel = {
  id: string
  /** Takes `input_references`. */
  refs: boolean
}

/**
 * The hero sets the grade the rest match, so it gets the best picture. One
 * draw each at 2K 16:9 with a reference, 2026-10-15, cheapest and fastest
 * first. Left out for cost and speed: Flux 3 (39.0 s, $0.10), Gemini 3.1 Flash
 * Image (22.6 s, $0.10) and, from the fast chain, Hunyuan Image 3.5 (11.1 s,
 * $0.024). Nano Banana 2.1 is out: its only provider, Google AI Studio,
 * answers 429.
 */
export const QUALITY_MODELS: readonly PhotoModel[] = [
  { id: "openai/gpt-image-2.5-flare", refs: true }, // 19.8 s, $0.012, 1536 px wide
  { id: "openai/gpt-image-2.5-sunburst", refs: true }, // 21.6 s, $0.012, 1536 px wide
  { id: "meta/muse-image", refs: true }, // 25.3 s, $0.010; drew 3:2 when asked 16:9
]
/** Every other slot, fastest and cheapest first. One draw each at 1K 4:3, 2026-10-15. */
export const FAST_MODELS: readonly PhotoModel[] = [
  { id: "recraft/recraft-v4.1-flash", refs: false }, // 5.4 s, $0.007
  { id: "google/gemini-3.1-flash-lite-image", refs: true }, // 4.8 s, $0.034
  { id: "bytedance-seed/seedream-5-0-flash", refs: true }, // 12.3 s, $0.018
]
/** Models a slot tries before it falls back. */
const TRIES = 3

/** With references to match, the models that read them go first. */
const chainFor = (hero: boolean, withRefs: boolean): PhotoModel[] => [
  ...(hero ? QUALITY_MODELS : []),
  ...(withRefs
    ? [
        ...FAST_MODELS.filter((m) => m.refs),
        ...FAST_MODELS.filter((m) => !m.refs),
      ]
    : FAST_MODELS),
]
export const MAX_PER_BUILD = 8
export const MAX_PER_DAY = 30
const PARALLEL = 4
/** Owner photos passed as references beside the hero: the grade matches theirs. */
const OWNER_REFERENCES = 2
/** The site's other generated photos a lone redraw is graded against. */
const SIBLING_REFERENCES = 4
const GENERATE_TIMEOUT_MS = 60_000
const PROMPT_TIMEOUT_MS = 30_000
/** Dollars, for a result whose response carried no cost. Verified 2026-10-14. */
const ESTIMATE = { "1K": 0.034, "2K": 0.05 } as const
const OPENROUTER = "https://openrouter.ai/api/v1"

/** Appended to every prompt, word for word the never-list of ADR-039. */
export const NEVER =
  "Show no face that could pass for a member of staff or a customer: any person is seen from behind or at a distance. " +
  "No text, logos, signage, number plates or brand badges. No certificates, awards, prices or before-and-after pairs. No watermark."

export type PhotoBrief = {
  industry: string
  /** The direction's `image_style`. */
  imageStyle: string
  /** The palette in words, such as "warm paper, sage primary, deep ink". */
  palette: string
}

export type PhotoResult = {
  slot_id: string
  status: "generated" | "reused" | "fallback"
  asset_id: string | null
  key: string | null
  content_type: string | null
  cost_usd: number | null
  /** Why a slot fell back, for the log. */
  reason: string | null
}

type Stored = { arrayBuffer: () => Promise<ArrayBuffer> }
export type PhotoBucket = {
  get: (key: string) => Promise<Stored | null>
  put: (
    key: string,
    value: Uint8Array,
    options: {
      httpMetadata: { contentType: string }
      customMetadata: Record<string, string>
    }
  ) => Promise<unknown>
  list: (options: { prefix: string; cursor?: string }) => Promise<{
    objects: { key: string; uploaded: Date }[]
    truncated: boolean
    cursor?: string
  }>
}

const EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
}
const extension = (contentType: string) => EXTENSION[contentType] ?? "png"

const sha256 = async (text: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    ),
    (b) => b.toString(16).padStart(2, "0")
  ).join("")

/** A UUID v4 in shape from a hash, the way `apps/api/src/assets.ts` makes upload ids. */
function uuidFrom(hash: string): string {
  const hex = hash.slice(0, 32).split("")
  hex[12] = "4"
  hex[16] = ((Number.parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16)
  const h = hex.join("")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

const generatedKey = (orgId: string, assetId: string) =>
  `generated/${orgId}/${assetId}`

function base64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

const fromBase64 = (b64: string) =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

type Slot = Extract<ImageSlot, { source: "generated" }>
type Planned = {
  slot: Slot
  resolution: "1K" | "2K"
  /** Hash of everything that makes the picture, so a rebuild finds it again. */
  hash: string
  assetId: string
}

type Deps = {
  key: string
  fetch: typeof fetch
}

const Prompts = z.object({
  style: z.string().min(1).max(400),
  subjects: z.record(z.string(), z.string().min(1).max(500)),
})

/** One Haiku call: a shared style line for the set and a subject line per slot. */
async function writePrompts(
  { key, fetch }: Deps,
  brief: PhotoBrief,
  slots: Planned[]
): Promise<z.infer<typeof Prompts> | null> {
  try {
    const response = await fetch(`${OPENROUTER}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(PROMPT_TIMEOUT_MS),
      body: JSON.stringify({
        model: MODELS.haiku.replace(/^openrouter\//, ""),
        max_tokens: ROLES.copy.maxTokens,
        reasoning: { effort: ROLES.copy.effort },
        messages: [
          {
            role: "system",
            content:
              "You are a photo director for a small business website. Write prompts for an image model. " +
              'Reply with JSON only: {"style": string, "subjects": {"<slot id>": string}}. ' +
              "`style` is one line shared by the whole set so the photos read as one shoot: light, colour grade, lens, one recurring prop in the palette. " +
              "Each subject is one concrete scene for its slot: a place, surface, object or hands at work. " +
              "Where a slot has a text side, ask for calm empty space on that side. Never ask for a face, text, a logo or a sign.",
          },
          {
            role: "user",
            content: JSON.stringify({
              industry: brief.industry,
              image_style: brief.imageStyle,
              palette: brief.palette,
              slots: slots.map(({ slot, resolution }) => ({
                id: slot.id,
                section: slot.section,
                aspect: slot.aspect,
                resolution,
                idea: slot.subject,
                text_side: slot.text_side ?? "none",
              })),
            }),
          },
        ],
      }),
    })
    if (!response.ok) return null
    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[]
    }
    const text = body.choices?.[0]?.message?.content ?? ""
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)
    const parsed = Prompts.safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

const SIDE_NOTE = (side: Slot["text_side"]) =>
  side && side !== "none"
    ? ` Keep the ${side} third of the frame calm and empty for text.`
    : ""

type Reference = { content_type: string; b64: string }

type Drawn =
  | {
      ok: true
      model: string
      bytes: Uint8Array
      b64: string
      contentType: string
      cost: number | null
    }
  /** `down`: the model, not the prompt, failed (quota, outage, timeout), so the build skips it. */
  | { ok: false; reason: string; down: boolean }

/** One image, or the reason there is none. A refusal is a 400 or an answer without a picture. */
async function draw(
  { key, fetch }: Deps,
  model: string,
  prompt: string,
  planned: Planned,
  references: Reference[]
): Promise<Drawn> {
  try {
    const response = await fetch(`${OPENROUTER}/images`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        prompt,
        resolution: planned.resolution,
        aspect_ratio: planned.slot.aspect,
        ...(references.length
          ? {
              input_references: references.map((r) => ({
                type: "image_url",
                image_url: { url: `data:${r.content_type};base64,${r.b64}` },
              })),
            }
          : {}),
      }),
    })
    if (!response.ok)
      return {
        ok: false,
        reason: `http ${response.status}`,
        down: response.status !== 400,
      }
    const body = (await response.json()) as {
      data?: { b64_json?: string; media_type?: string }[]
      usage?: { cost?: number }
    }
    const image = body.data?.find((d) => d.b64_json)
    if (!image?.b64_json)
      return { ok: false, reason: "no image returned", down: false }
    return {
      ok: true,
      model,
      b64: image.b64_json,
      bytes: fromBase64(image.b64_json),
      contentType: image.media_type ?? "image/png",
      cost: typeof body.usage?.cost === "number" ? body.usage.cost : null,
    }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.name : "error",
      down: true,
    }
  }
}

/** The first clause of a subject: what is left when the long one is refused. */
const simplified = (subject: string) => subject.split(/[,;.]/)[0]?.trim() ?? ""

const fallback = (slot_id: string, reason: string): PhotoResult => ({
  slot_id,
  status: "fallback",
  asset_id: null,
  key: null,
  content_type: null,
  cost_usd: null,
  reason,
})

async function readDaysCount(
  sites: PhotoBucket,
  orgId: string,
  now: Date
): Promise<number> {
  const since = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  )
  let count = 0
  let cursor: string | undefined
  for (let page = 0; page < 5; page++) {
    const listed = await sites.list({ prefix: `generated/${orgId}/`, cursor })
    count += listed.objects.filter((o) => o.uploaded.getTime() >= since).length
    if (!listed.truncated) break
    cursor = listed.cursor
  }
  return count
}

/**
 * Fills a plan's generated slots. Claim sections are never drawn (the claims
 * gate refuses them anyway), the eight-photo and thirty-a-day caps leave the
 * rest to the fallback, and a slot whose picture already exists is reused.
 * `uploads` are the owner's photos, passed as references so a generated room
 * sits next to real ones.
 */
export async function directPhotos(input: {
  env: { OPENROUTER_API_KEY: string; SITES: PhotoBucket }
  orgId: string
  plan: Pick<Blueprint, "images" | "pages">
  brief: PhotoBrief
  uploads?: { id: string; content_type: string }[]
  /** Asset ids of the site's other generated photos, passed as references after the owner's (a lone redraw). */
  siblings?: string[]
  /** Makes the hash, so the picture, new: "Try another" passes its assignment id. */
  variation?: string
  /** Told as each slot settles, for the build's per-photo progress; a throw is ignored. */
  onSlot?: (result: PhotoResult) => unknown
  fetch?: typeof fetch
  now?: Date
}): Promise<PhotoResult[]> {
  const { env, orgId, plan, brief } = input
  const deps: Deps = {
    key: env.OPENROUTER_API_KEY,
    fetch: input.fetch ?? fetch,
  }
  const results = new Map<string, PhotoResult>()
  const told: Promise<unknown>[] = []
  const settle = (id: string, result: PhotoResult) => {
    results.set(id, result)
    if (input.onSlot) {
      told.push(Promise.resolve(input.onSlot(result)).catch(() => undefined))
    }
  }
  const claims = new Set(
    generatedImageFindings(plan).map((f) => f.node.replace(/^images\./, ""))
  )
  const wanted = plan.images.filter(
    (s): s is Slot => s.source === "generated" && !s.asset_id
  )
  const hero = wanted.find((s) => s.section === "hero") ?? wanted[0]
  const ordered = [...(hero ? [hero] : []), ...wanted.filter((s) => s !== hero)]
  const planned: Planned[] = []
  for (const slot of ordered) {
    if (claims.has(slot.id)) {
      settle(slot.id, fallback(slot.id, "claim section"))
    } else if (planned.length >= MAX_PER_BUILD) {
      settle(slot.id, fallback(slot.id, "build cap"))
    } else {
      const resolution = slot === hero ? "2K" : "1K"
      const hash = await sha256(
        JSON.stringify([
          resolution,
          slot.aspect,
          slot.subject,
          slot.text_side ?? "none",
          brief,
          ...(input.variation ? [input.variation] : []),
        ])
      )
      planned.push({ slot, resolution, hash, assetId: uuidFrom(hash) })
    }
  }

  // Reuse: the id is the hash, so the prefix is the whole lookup.
  const misses: Planned[] = []
  const stored = new Map<string, { key: string; contentType: string }>()
  for (const p of planned) {
    const prefix = generatedKey(orgId, p.assetId)
    const found = (await env.SITES.list({ prefix: `${prefix}.` })).objects[0]
    if (!found) {
      misses.push(p)
      continue
    }
    const ext = found.key.slice(prefix.length + 1)
    const contentType =
      Object.entries(EXTENSION).find(([, e]) => e === ext)?.[0] ?? "image/png"
    stored.set(p.slot.id, { key: found.key, contentType })
    settle(p.slot.id, {
      slot_id: p.slot.id,
      status: "reused",
      asset_id: p.assetId,
      key: found.key,
      content_type: contentType,
      cost_usd: 0,
      reason: null,
    })
  }

  const room = Math.max(
    0,
    MAX_PER_DAY -
      (misses.length
        ? await readDaysCount(env.SITES, orgId, input.now ?? new Date())
        : 0)
  )
  const toDraw = misses.slice(0, room)
  for (const p of misses.slice(room))
    settle(p.slot.id, fallback(p.slot.id, "daily cap"))

  if (toDraw.length) {
    const written = await writePrompts(deps, brief, toDraw)
    const promptFor = (p: Planned, subject: string) =>
      `${written?.style ?? brief.imageStyle} ${subject}${SIDE_NOTE(p.slot.text_side)} ${NEVER}`
    const subjectOf = (p: Planned) =>
      written?.subjects[p.slot.id] ?? p.slot.subject

    // Owner photos first in line as references, the hero joins once it exists.
    const owner: Reference[] = []
    for (const upload of (input.uploads ?? []).slice(0, OWNER_REFERENCES)) {
      const object = await env.SITES.get(photoKey(orgId, upload.id))
      if (object)
        owner.push({
          content_type: upload.content_type,
          b64: base64(new Uint8Array(await object.arrayBuffer())),
        })
    }

    for (const id of (input.siblings ?? []).slice(0, SIBLING_REFERENCES)) {
      const prefix = generatedKey(orgId, id)
      const found = (await env.SITES.list({ prefix: `${prefix}.` })).objects[0]
      const object = found && (await env.SITES.get(found.key))
      if (found && object) {
        const ext = found.key.slice(prefix.length + 1)
        owner.push({
          content_type:
            Object.entries(EXTENSION).find(([, e]) => e === ext)?.[0] ??
            "image/png",
          b64: base64(new Uint8Array(await object.arrayBuffer())),
        })
      }
    }

    // A model that is down for one slot is down for the rest of this build.
    const down = new Set<string>()
    const one = async (p: Planned, references: Reference[]) => {
      let prompt = promptFor(p, subjectOf(p))
      let refs = references
      let drawn: Drawn = { ok: false, reason: "no model up", down: false }
      let tries = 0
      for (const model of chainFor(
        p.slot.section === "hero",
        refs.length > 0
      )) {
        if (down.has(model.id)) continue
        if (tries++ === TRIES) break
        drawn = await draw(deps, model.id, prompt, p, model.refs ? refs : [])
        if (drawn.ok) break
        if (drawn.down) down.add(model.id)
        else {
          // A refused slot moves on with its simplest subject, no references.
          prompt = promptFor(p, simplified(p.slot.subject) || p.slot.subject)
          refs = []
        }
      }
      if (!drawn.ok) {
        settle(p.slot.id, fallback(p.slot.id, drawn.reason))
        return null
      }
      const objectKey = `${generatedKey(orgId, p.assetId)}.${extension(drawn.contentType)}`
      try {
        await env.SITES.put(objectKey, drawn.bytes, {
          httpMetadata: { contentType: drawn.contentType },
          customMetadata: {
            source: "generated",
            model: drawn.model,
            prompt_hash: p.hash,
            cost_usd: String(drawn.cost ?? ESTIMATE[p.resolution]),
          },
        })
      } catch {
        settle(p.slot.id, fallback(p.slot.id, "store failed"))
        return null
      }
      settle(p.slot.id, {
        slot_id: p.slot.id,
        status: "generated",
        asset_id: p.assetId,
        key: objectKey,
        content_type: drawn.contentType,
        cost_usd: drawn.cost,
        reason: null,
      })
      return { content_type: drawn.contentType, b64: drawn.b64 }
    }

    // The hero goes first so the rest can match its grade; a reused hero is
    // read back from the bucket for the same reason.
    const [first, ...rest] = toDraw
    let shared = owner
    const reusedHero = hero && stored.get(hero.id)
    if (reusedHero) {
      const object = await env.SITES.get(reusedHero.key)
      if (object)
        shared = [
          {
            content_type: reusedHero.contentType,
            b64: base64(new Uint8Array(await object.arrayBuffer())),
          },
          ...owner,
        ]
    }
    if (first && first.slot === hero) {
      const heroRef = await one(first, owner)
      if (heroRef) shared = [heroRef, ...owner]
    } else if (first) {
      rest.unshift(first)
    }
    const bounded = limit(PARALLEL)
    await Promise.all(rest.map((p) => bounded(() => one(p, shared))))
  }

  await Promise.all(told)
  return ordered.map((s) => results.get(s.id) ?? fallback(s.id, "not planned"))
}

/** Where a generated slot's picture lives in the site, which its site field names. */
export const generatedPath = (slotId: string, contentType: string | null) =>
  `src/assets/generated/${slotId}.${extension(contentType ?? "")}`

/**
 * Copies generated photos from the bucket into the site's
 * `src/assets/generated/{slot id}.{ext}`, where `astro:assets` finds them and
 * the source snapshot keeps them, the way `placePhotos` does for uploads.
 * Returns the paths it wrote; the rest fall back.
 */
export async function placeGenerated(
  sandbox: {
    exec: (command: string) => Promise<unknown>
    writeFile: (path: string, content: Uint8Array) => Promise<unknown>
  },
  sites: Pick<PhotoBucket, "get">,
  results: readonly Pick<
    PhotoResult,
    "slot_id" | "status" | "key" | "content_type"
  >[]
): Promise<Record<string, string>> {
  const placed: Record<string, string> = {}
  const ready = results.filter((r) => r.key && r.status !== "fallback")
  if (ready.length === 0) return placed
  await sandbox.exec(`mkdir -p ${SITE_ROOT}/src/assets/generated`)
  for (const r of ready) {
    const object = await sites.get(r.key as string)
    if (!object) continue
    const path = generatedPath(r.slot_id, r.content_type)
    await sandbox.writeFile(
      `${SITE_ROOT}/${path}`,
      new Uint8Array(await object.arrayBuffer())
    )
    placed[r.slot_id] = path
  }
  return placed
}
