import { ImageSlot } from "@workspace/contracts"
import { events, sql, type Tenancy } from "@workspace/db"
import { z } from "zod"
import { directPhotos, type PhotoBucket, placeGenerated } from "./images.ts"
import { SITE_ROOT } from "./revise.ts"

/**
 * IG4's one-slot regenerate, the quick lane's `photo` kind. The generated
 * slots of the live site ride the log as a `site.photos` event (the build
 * that places photos writes it, and so does every regenerate), so the
 * review card and this lane read the same record. No such event means no
 * generated photo to redo, and the change falls through to the Developer.
 */

/** "Try another" for the same slot, per day (IG4). */
export const SLOT_DAILY_CAP = 5

export const PhotosEvent = z.object({
  slots: z.array(ImageSlot).max(24),
  brief: z.object({
    industry: z.string(),
    imageStyle: z.string(),
    palette: z.string(),
  }),
  /** The slot this event regenerated, which the daily cap counts. */
  regenerated: z.string().nullable(),
})
export type PhotosEvent = z.infer<typeof PhotosEvent>

/** The newest `site.photos` of the org: what the live site was last built with. */
export async function readPhotos(
  kit: Tenancy,
  orgId: string
): Promise<PhotosEvent | null> {
  const [row] = await kit.withOrg({ orgId }, (db) =>
    db
      .select({ payload: events.payload })
      .from(events)
      .where(sql`${events.type} = 'site.photos'`)
      .orderBy(sql`${events.eventId} desc`)
      .limit(1)
  )
  const parsed = PhotosEvent.safeParse(row?.payload)
  return parsed.success ? parsed.data : null
}

/** How often the slot was regenerated in the last day. */
export async function triesToday(
  kit: Tenancy,
  orgId: string,
  slotId: string
): Promise<number> {
  const [row] = await kit.withOrg({ orgId }, (db) =>
    db
      .select({ n: sql<string>`count(*)` })
      .from(events)
      .where(
        sql`${events.type} = 'site.photos' and ${events.payload}->>'regenerated' = ${slotId} and ${events.recordedAt} > now() - interval '1 day'`
      )
  )
  return Number(row?.n ?? 0)
}

/**
 * The slot an owner's words mean: its id when named (the review card does),
 * else the one slot of a section the words name, else the only slot. Anything
 * else is ambiguous and goes to the Developer, who can ask.
 */
export function pickSlot(
  slots: readonly ImageSlot[],
  goal: string
): Extract<ImageSlot, { source: "generated" }> | null {
  const generated = slots.filter(
    (s): s is Extract<ImageSlot, { source: "generated" }> =>
      s.source === "generated"
  )
  const text = goal.toLowerCase()
  const named = generated.filter((s) => text.includes(s.id))
  if (named.length === 1) return named[0] as (typeof generated)[number]
  const section = generated.filter((s) =>
    text.includes(s.section.replaceAll("_", " "))
  )
  if (section.length === 1) return section[0] as (typeof generated)[number]
  return slots.length === 1 && generated.length === 1
    ? (generated[0] as (typeof generated)[number])
    : null
}

export class PhotoFell extends Error {}

/**
 * Draws a fresh picture for one slot and puts it on disk where the old one
 * was. The variation is the assignment id, so a replayed step finds the
 * picture it already paid for. Throws `PhotoFell` with a reason the log and
 * the fall-through can read; writes nothing to the site until the picture
 * exists.
 *
 * shortcut: the new file must keep the old one's extension (the site config
 * names the file); a different type falls through. The slot is drawn alone,
 * so a non-hero slot is drawn at 2K and the rest of the set is not passed as
 * a reference. Both are cheap to lift once the Blueprint carries them.
 */
export async function regenerateSlot(input: {
  env: { OPENROUTER_API_KEY?: string; SITES: unknown }
  kit: Tenancy
  sandbox: {
    exec: (
      command: string
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
    writeFile: (path: string, content: Uint8Array) => Promise<unknown>
  }
  orgId: string
  assignmentId: string
  goal: string
  fetch?: typeof fetch
}): Promise<{ summary: string; path: string; photos: PhotosEvent }> {
  const { env, kit, sandbox, orgId } = input
  if (!env.OPENROUTER_API_KEY) throw new PhotoFell("photo: no image key")
  const sites = env.SITES as PhotoBucket
  const photos = await readPhotos(kit, orgId)
  if (!photos) throw new PhotoFell("photo: no generated photos recorded")
  const slot = pickSlot(photos.slots, input.goal)
  if (!slot) throw new PhotoFell("photo: no single slot named")
  if ((await triesToday(kit, orgId, slot.id)) >= SLOT_DAILY_CAP) {
    throw new PhotoFell("photo: slot cap")
  }
  const { asset_id: _old, ...fresh } = slot
  const [result] = await directPhotos({
    env: { OPENROUTER_API_KEY: env.OPENROUTER_API_KEY, SITES: sites },
    orgId,
    plan: { images: [fresh], pages: [] },
    brief: photos.brief,
    variation: input.assignmentId,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  })
  if (!result || result.status === "fallback" || !result.asset_id) {
    throw new PhotoFell(`photo: ${result?.reason ?? "no result"}`)
  }
  const dir = `${SITE_ROOT}/src/assets/generated`
  const old = await sandbox.exec(`ls ${dir} | grep -E '^${slot.id}\\.'`)
  const path = `src/assets/generated/${slot.id}.${result.key?.split(".").pop()}`
  const onDisk = old.stdout.split("\n").filter(Boolean)
  if (onDisk.length === 0)
    throw new PhotoFell("photo: slot has no file on disk")
  if (!onDisk.includes(path.split("/").pop() as string)) {
    throw new PhotoFell("photo: the new picture has another file type")
  }
  await placeGenerated(sandbox, sites, [result])
  return {
    summary: `Drew a new picture for “${slot.alt}”.`,
    path,
    photos: {
      ...photos,
      slots: photos.slots.map((s) =>
        s.id === slot.id ? { ...s, asset_id: result.asset_id as string } : s
      ),
      regenerated: slot.id,
    },
  }
}
