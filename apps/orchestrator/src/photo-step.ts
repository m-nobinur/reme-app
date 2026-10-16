import { Blueprint, PALETTES } from "@workspace/contracts"
import {
  appendEvent,
  assignments,
  currentFacts,
  eq,
  events,
  sql,
  type Tenancy,
  toFactRecord,
} from "@workspace/db"
import { industryOf, ownerPhotos } from "./developer-rules.ts"
import { DIRECTIONS } from "./directions.ts"
import {
  directPhotos,
  type PhotoBrief,
  type PhotoBucket,
  type PhotoResult,
} from "./images.ts"
import type { PhotosEvent } from "./photo-quick.ts"
import type { Ids } from "./state.ts"

/**
 * BA4: the Blueprint's generated photos, made after the owner decided on the
 * plan and before the page builders start, in a Workflow step of its own so a
 * retry reuses what was drawn (the asset id is the picture's hash). A slot
 * that fell back leaves the plan, so its section renders its no-image form;
 * the rest get their asset id. The plan on the row, the `site.photos` event
 * (IG4's shape, what the review card and "Try another" read) and the files
 * the Developer places are written once, in one transaction.
 */

/** A placed picture: what the Developer copies into the site, by slot. */
export type PhotoFile = Pick<
  PhotoResult,
  "slot_id" | "status" | "key" | "content_type"
>

/** The step's answer: counts and the files, eight at most (R8, ids only). */
type PhotoStep = {
  generated: number
  fell_back: number
  files: PhotoFile[]
}

/**
 * The plan's slots once the photos are made: a slot that fell back leaves,
 * a made one carries its asset id, the owner's stay as they are.
 */
export function applyPhotos(
  slots: Blueprint["images"],
  results: readonly PhotoResult[]
): { images: Blueprint["images"]; step: PhotoStep } {
  const kept = new Map(
    results.filter((r) => r.status !== "fallback").map((r) => [r.slot_id, r])
  )
  const fell = new Set(
    results.filter((r) => r.status === "fallback").map((r) => r.slot_id)
  )
  const images = slots.flatMap((s) => {
    if (fell.has(s.id)) return []
    const got = kept.get(s.id)
    return got?.asset_id ? [{ ...s, asset_id: got.asset_id }] : [s]
  })
  return {
    images,
    step: {
      generated: kept.size,
      fell_back: fell.size,
      files: [...kept.values()].map(
        ({ slot_id, status, key, content_type }) => ({
          slot_id,
          status,
          key,
          content_type,
        })
      ),
    },
  }
}

/** The palette in words for the prompt writer. */
function paletteWords(plan: Blueprint): string {
  if (plan.palette.kind === "brand") {
    return `the owner's brand colour ${plan.palette.brand}`
  }
  const id = plan.palette.id
  const p = PALETTES.find((each) => each.id === id)
  return p
    ? `${p.label}: paper ${p.paper}, primary ${p.primary}, accent ${p.accent}, ink ${p.ink}`
    : id
}

export async function makePhotos(input: {
  env: { OPENROUTER_API_KEY?: string; SITES: unknown }
  kit: Tenancy
  ids: Ids
  fetch?: typeof fetch
}): Promise<PhotoStep> {
  const { env, kit, ids } = input
  const read = await kit.withOrg({ orgId: ids.orgId }, async (db) => {
    const [done] = await db
      .select({ payload: events.payload })
      .from(events)
      .where(
        sql`${events.assignmentId} = ${ids.assignmentId} and ${events.type} = 'site.photos'`
      )
      .limit(1)
    if (done) return { done: done.payload.step as PhotoStep }
    const [row] = await db
      .select({
        blueprint: assignments.blueprint,
        staffId: assignments.staffId,
      })
      .from(assignments)
      .where(eq(assignments.id, ids.assignmentId))
    const facts = (await currentFacts(db)).map(toFactRecord)
    return { done: null, row, facts }
  })
  if (read.done) return read.done
  const plan = Blueprint.safeParse(read.row?.blueprint)
  const none: PhotoStep = { generated: 0, fell_back: 0, files: [] }
  if (!plan.success) return none
  const wanted = plan.data.images.filter(
    (s) => s.source === "generated" && !s.asset_id
  )
  if (wanted.length === 0) return none

  const brief: PhotoBrief = {
    industry: industryOf(read.facts) ?? "local service business",
    imageStyle:
      DIRECTIONS.find((d) => d.id === plan.data.direction)?.image_style ??
      "Natural light, real places, calm composition.",
    palette: paletteWords(plan.data),
  }
  // The "0 of n" row first, then one per slot as it settles, with its
  // asset id so the panel can show the picture the moment it exists, and
  // its key so `write_pages` places it in the site while the rest draw.
  const progress = (slot: PhotoResult | null) =>
    kit.withOrg({ orgId: ids.orgId }, (db) =>
      appendEvent(db, {
        orgId: ids.orgId,
        assignmentId: ids.assignmentId,
        staffId: null,
        type: "build.progress",
        payload: {
          stage: "photos",
          item: slot?.slot_id ?? null,
          total: wanted.length,
          ...(slot
            ? {
                status: slot.status,
                asset_id: slot.asset_id,
                key: slot.key,
                content_type: slot.content_type,
              }
            : {}),
        },
      })
    )
  await progress(null)
  const results = env.OPENROUTER_API_KEY
    ? await directPhotos({
        env: {
          OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
          SITES: env.SITES as PhotoBucket,
        },
        orgId: ids.orgId,
        plan: plan.data,
        brief,
        uploads: ownerPhotos(read.facts),
        onSlot: progress,
        ...(input.fetch ? { fetch: input.fetch } : {}),
      })
    : wanted.map((s) => ({
        slot_id: s.id,
        status: "fallback" as const,
        asset_id: null,
        key: null,
        content_type: null,
        cost_usd: null,
        reason: "no image key",
      }))

  const { images, step } = applyPhotos(plan.data.images, results)
  const photos: PhotosEvent = { slots: images, brief, regenerated: null }
  await kit.withOrg({ orgId: ids.orgId }, async (db) => {
    await db
      .update(assignments)
      .set({ blueprint: { ...plan.data, images } })
      .where(eq(assignments.id, ids.assignmentId))
    await appendEvent(db, {
      orgId: ids.orgId,
      assignmentId: ids.assignmentId,
      staffId: read.row?.staffId ?? null,
      type: "site.photos",
      // `step` is this step's answer for a retry; readers parse IG4's fields.
      payload: {
        ...photos,
        step,
        fell_back: results
          .filter((r) => r.status === "fallback")
          .map((r) => ({ slot_id: r.slot_id, reason: r.reason })),
      },
      taint: ["inferred"],
    })
  })
  return step
}
