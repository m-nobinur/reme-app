import {
  type Asset,
  idempotencyKey,
  SiteMedia,
  thumbnailOf,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_FILES,
  type UploadedAssets,
} from "@workspace/contracts"
import { sql, type Tenancy } from "@workspace/db"
import { type Owner, stateFacts } from "./changes.ts"
import { failure, invalid, keyMissing, sha256Hex } from "./http.ts"
import { factValue, logoOf } from "./onboarding.ts"
import { readFacts } from "./workspace.ts"

/**
 * `POST /assets`: the owner's photos for the site, from onboarding's upload
 * card. Multipart, field `files`. Each file's type is read from its first
 * bytes and the client's content type is ignored; only JPEG, PNG and WebP
 * pass, at most `UPLOAD_MAX_BYTES` each and `UPLOAD_MAX_FILES` for the org in
 * all. The bytes go to the site bucket under `uploads/{org_id}/{asset_id}`,
 * and the list goes to the `media.uploads` fact, which the build reads.
 *
 * Ids come from the org, the request's Idempotency-Key and the file's place
 * in the form, so a retried request writes the same objects and the same
 * list entries again rather than new ones.
 *
 * ponytail: no re-encoding and no malware scan. A decoder in the Worker, or a
 * queue to one, once uploads come from anyone but the signed-in owner.
 */

type Kind = Asset["content_type"]

const SIGNATURES: [Kind, (b: Uint8Array) => boolean][] = [
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  [
    "image/png",
    (b) =>
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
        (byte, i) => b[i] === byte
      ),
  ],
  [
    "image/webp",
    (b) =>
      String.fromCharCode(...b.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...b.slice(8, 12)) === "WEBP",
  ],
]

/** The image type the bytes are, or null for anything else. */
export function sniff(bytes: Uint8Array): Kind | null {
  return SIGNATURES.find(([, matches]) => matches(bytes))?.[0] ?? null
}

const EXTENSION: Record<Kind, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
}

/** The file's own name without its folders, its extension or anything but plain characters. */
export function cleanName(name: string, kind: Kind): string {
  const base = (name.split(/[\\/]/).pop() ?? "")
    .replace(/\.[^.]*$/, "")
    .replace(/[^\p{L}\p{N} _-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100)
    .trim()
  return `${base || "photo"}.${EXTENSION[kind]}`
}

/** A UUID v4 in shape, from a hash, so the same inputs make the same id. */
export async function stableId(seed: string): Promise<string> {
  const hex = (await sha256Hex(seed)).slice(0, 32).split("")
  hex[12] = "4"
  hex[16] = ((Number.parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16)
  const h = hex.join("")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** The object key a photo is stored under. The orchestrator reads the same. */
export const uploadKey = (orgId: string, assetId: string) =>
  `uploads/${orgId}/${assetId}`

/** Room for the form's own framing on top of the files. */
const FORM_SLACK = 64 * 1024

const refused = (status: number, code: string, message: string) =>
  failure(status, { class: "validation", code, message, detail: {} })

const tooMany = () =>
  refused(
    409,
    "assets.too_many",
    `A business can keep at most ${UPLOAD_MAX_FILES} photos.`
  )

/**
 * Rewrites `media.uploads` with `edit`, read and written under the org's
 * upload lock so two writers at once both land. The stored list, or null
 * when the edit would pass `UPLOAD_MAX_FILES` and nothing was written.
 */
export async function editUploads(
  kit: Tenancy,
  owner: Owner,
  edit: (items: readonly Asset[]) => Asset[]
): Promise<Asset[] | null> {
  const scope = { orgId: owner.orgId, workosUserId: owner.session.workosUserId }
  return kit.withOrg(scope, async (db) => {
    await db.execute(
      sql`select pg_advisory_xact_lock(3, hashtext(${owner.orgId}::text))`
    )
    const current = await readFacts(db)
    const items = edit(factValue(current, "media.uploads")?.items ?? [])
    if (items.length > UPLOAD_MAX_FILES) return null
    await stateFacts(
      db,
      owner,
      [{ key: "media.uploads", value: { items } }],
      current
    )
    return items
  })
}

export async function uploadAssets(
  request: Request,
  env: Env,
  kit: Tenancy,
  owner: Owner
): Promise<Response> {
  const key = idempotencyKey(request)
  if (!key) return keyMissing()
  const declared = Number(request.headers.get("content-length"))
  if (declared > UPLOAD_MAX_FILES * UPLOAD_MAX_BYTES + FORM_SLACK) {
    return refused(413, "assets.too_large", "That upload is too large.")
  }
  const form = await request.formData().catch(() => null)
  const files = (form?.getAll("files") ?? []).filter(
    (f): f is File => typeof f !== "string"
  )
  if (files.length === 0) return invalid([{ path: ["files"] }])
  if (files.length > UPLOAD_MAX_FILES) return tooMany()
  const scope = { orgId: owner.orgId, workosUserId: owner.session.workosUserId }
  const held = await kit.withOrg(scope, readFacts)
  const before = factValue(held, "media.uploads")?.items ?? []

  const made: { asset: Asset; file: File }[] = []
  for (const [index, file] of files.entries()) {
    if (file.size > UPLOAD_MAX_BYTES) {
      return refused(
        413,
        "assets.too_large",
        `Each photo is at most ${UPLOAD_MAX_BYTES / 1024 / 1024} MB.`
      )
    }
    // The signature only, so twelve photos are not each copied into memory.
    const kind = sniff(new Uint8Array(await file.slice(0, 12).arrayBuffer()))
    if (!kind) {
      return refused(
        415,
        "assets.type",
        "Photos must be JPEG, PNG or WebP images."
      )
    }
    made.push({
      file,
      asset: {
        id: await stableId(`${owner.orgId}:${key}:${index}`),
        name: cleanName(file.name, kind),
        content_type: kind,
        bytes: file.size,
      },
    })
  }
  const merged = (list: readonly Asset[]) => [
    ...list.filter((a) => !made.some((m) => m.asset.id === a.id)),
    ...made.map((m) => m.asset),
  ]
  if (merged(before).length > UPLOAD_MAX_FILES) return tooMany()

  for (const { asset, file } of made) {
    await env.SITES.put(uploadKey(owner.orgId, asset.id), file, {
      httpMetadata: { contentType: asset.content_type },
    })
  }
  const stored = await editUploads(kit, owner, merged)
  if (!stored) {
    await Promise.all(
      made
        .filter((m) => !before.some((a) => a.id === m.asset.id))
        .map((m) => env.SITES.delete(uploadKey(owner.orgId, m.asset.id)))
    )
    return tooMany()
  }
  const body: UploadedAssets = { assets: made.map((m) => m.asset) }
  return Response.json(body, { status: 201 })
}

/** The thumbnail's width in pixels, about three times its tile for sharp screens. */
const THUMB_WIDTH = 320
/**
 * The design tray's width: its photo and logo tiles are about 160 px, and a
 * logo's lettering blurs at 320, so tray pictures are made at 512.
 */
const TRAY_WIDTH = 512

/** The types a generated photo is stored as, most likely first. */
const PHOTO_EXTENSIONS = ["png", "webp", "jpg"] as const

/** The custom metadata a drawn logo variant is stored with, beside the builder's photos. */
export const LOGO_VARIANT = { use: "logo" } as const

/**
 * `GET /photos/{asset id}`: one picture of the caller's org. A generated
 * photo, for the panel's thumbnails and the review card; a drawn logo
 * variant; or an owner's upload, so the tray shows held photos and a held
 * logo after a reload. The key starts with the session's own org, so another
 * org's id is a miss like any other: 404, saying nothing about whether it
 * exists. Ids are hashes of what made the bytes, which never change, so the
 * answer is cached for good, privately.
 *
 * The answer is a WebP made by the Images binding, 320 px for a generated
 * photo (the originals are about 2 MB and the tiles show them about 100 px
 * wide) and `TRAY_WIDTH` for a logo or an upload. Without the binding, or if
 * it refuses the bytes, the original is served instead.
 *
 * shortcut: re-made on every uncached request (billed once per image a
 * month); store it beside the original if that cost or latency shows.
 */
export async function readPhoto(
  env: Env,
  owner: Owner,
  assetId: string
): Promise<Response> {
  const object = await findPicture(env, owner.orgId, assetId)
  if (object) {
    const tray =
      object.key.startsWith("uploads/") ||
      object.customMetadata?.use === LOGO_VARIANT.use
    const headers = {
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    }
    const [forThumb, original] = object.body.tee()
    const thumb = await env.IMAGES?.input(forThumb)
      .transform({ width: tray ? TRAY_WIDTH : THUMB_WIDTH })
      .output({ format: "image/webp", quality: 75 })
      .catch(() => null)
    if (thumb) {
      return new Response(thumb.image(), {
        headers: { ...headers, "content-type": thumb.contentType() },
      })
    }
    return new Response(original, {
      headers: {
        ...headers,
        "content-type":
          object.httpMetadata?.contentType ??
          `image/${object.key.split(".").pop()}`,
      },
    })
  }
  return failure(404, {
    class: "resource",
    code: "photo.not_found",
    message: "No photo with that id in this business.",
    detail: {},
  })
}

/** The widest a version's screenshot is served: a card shows it at most 576 px wide, at twice that for a sharp screen. */
const SHOT_WIDTH = 1200

/**
 * `GET /revisions/{revision id}/{picture}`: one version's home page at a
 * screenshot width, or its icon, read from the revision's own prefix in the
 * site bucket. Like `readPhoto`, the key starts with the session's org (a
 * site's id is its org's), so another org's revision is a plain 404, and a
 * revision never changes, so the answer is cached for good, privately.
 *
 * A screenshot is the whole page; the cards show its first screen, so it is
 * cut to that, 16:10 from the top, as a WebP. Without the Images binding, or
 * if it refuses the bytes, the original is served instead.
 */
export async function readRevisionPicture(
  env: Env,
  owner: Owner,
  revisionId: string,
  picture: string
): Promise<Response> {
  const base = `sites/${owner.orgId}/${revisionId}/`
  const object = await env.SITES.get(
    picture === "icon"
      ? `${base}dist/icon-192.png`
      : `${base}screenshots/${picture}.png`
  )
  if (!object) {
    return failure(404, {
      class: "resource",
      code: "picture.not_found",
      message: "That version has no such picture yet.",
      detail: {},
    })
  }
  const headers = {
    "cache-control": "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  }
  const png = { ...headers, "content-type": "image/png" }
  if (picture === "icon") return new Response(object.body, { headers: png })
  const width = Math.min(Number(picture.slice("home-".length)), SHOT_WIDTH)
  const [forShot, body] = object.body.tee()
  const shot = await env.IMAGES?.input(forShot)
    .transform({
      width,
      height: Math.round((width * 10) / 16),
      fit: "cover",
      gravity: "top",
    })
    .output({ format: "image/webp", quality: 80 })
    .catch(() => null)
  return shot
    ? new Response(shot.image(), {
        headers: { ...headers, "content-type": shot.contentType() },
      })
    : new Response(body, { headers: png })
}

/** One placed picture, as a build's `site.photos` event lists it. */
type PlacedSlot = {
  id: string
  section: string
  alt: string
  source: string
  asset_id?: string
}

/**
 * `GET /site/media`: the logo the org holds, and the pictures on its newest
 * version as that build's newest `site.photos` event placed them: the build
 * waiting for review (as `readApprovals` reads it), else the live one.
 */
export async function readSiteMedia(
  kit: Tenancy,
  owner: Owner
): Promise<Response> {
  const media = await kit.withOrg({ orgId: owner.orgId }, async (db) => {
    const held = await readFacts(db)
    const [placed] = (await db.execute(
      sql`select payload->'slots' as slots from events where type = 'site.photos' and assignment_id = coalesce(
        (select a.assignment_id from approvals a join assignments s on s.id = a.assignment_id where a.decision is null and ((s.state = 'awaiting_review' and a.expires_at > now()) or s.state = 'blocked_on_approval') order by a.requested_at desc limit 1),
        (select r.assignment_id from deployments d join site_revisions r on r.id = d.revision_id where d.site_id = (select id from orgs limit 1) order by d.config_version desc limit 1)
      ) order by event_id desc limit 1`
    )) as unknown as { slots: PlacedSlot[] | null }[]
    return SiteMedia.parse({
      logo: logoOf(held) ?? null,
      photos: (placed?.slots ?? []).map((slot) => ({
        slot_id: slot.id,
        section: slot.section,
        alt: slot.alt.slice(0, 200),
        generated: slot.source === "generated",
        thumbnail: thumbnailOf(slot.asset_id),
      })),
    })
  })
  return Response.json(media, { headers: { "cache-control": "no-store" } })
}

/** A generated picture of the org's, with its extension found by trying each. */
export async function findGenerated(
  env: Env,
  orgId: string,
  assetId: string
): Promise<R2ObjectBody | null> {
  for (const ext of PHOTO_EXTENSIONS) {
    const object = await env.SITES.get(`generated/${orgId}/${assetId}.${ext}`)
    if (object) return object
  }
  return null
}

/** A generated picture of the org's, or else one of its uploads. */
const findPicture = async (env: Env, orgId: string, assetId: string) =>
  (await findGenerated(env, orgId, assetId)) ??
  env.SITES.get(uploadKey(orgId, assetId))
