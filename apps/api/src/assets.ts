import {
  type Asset,
  idempotencyKey,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_FILES,
  type UploadedAssets,
} from "@workspace/contracts"
import { sql, type Tenancy } from "@workspace/db"
import { type Owner, stateFacts } from "./changes.ts"
import { failure, invalid, keyMissing, sha256Hex } from "./http.ts"
import { factValue } from "./onboarding.ts"
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
async function stableId(seed: string): Promise<string> {
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
  // Read and written under the org's upload lock, so two uploads at once
  // both land in the list.
  const stored = await kit.withOrg(scope, async (db) => {
    await db.execute(
      sql`select pg_advisory_xact_lock(3, hashtext(${owner.orgId}::text))`
    )
    const current = await readFacts(db)
    const items = merged(factValue(current, "media.uploads")?.items ?? [])
    if (items.length > UPLOAD_MAX_FILES) return false
    await stateFacts(
      db,
      owner,
      [{ key: "media.uploads", value: { items } }],
      current
    )
    return true
  })
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

/** The types a generated photo is stored as, most likely first. */
const PHOTO_EXTENSIONS = ["png", "webp", "jpg"] as const

/**
 * `GET /photos/{asset id}`: one generated photo of the caller's org, for the
 * panel's thumbnails and the review card. The key starts with the session's
 * own org, so another org's id is a miss like any other: 404, saying nothing
 * about whether it exists. The id is the picture's hash, so the bytes behind
 * it never change and the answer is cached for good, privately.
 *
 * The answer is a 320 px WebP made by the Images binding: the originals are
 * about 2 MB and the tiles show them about 100 px wide. Without the binding,
 * or if it refuses the bytes, the original is served instead.
 *
 * shortcut: re-made on every uncached request (billed once per image a
 * month); store it beside the original if that cost or latency shows.
 */
export async function readPhoto(
  env: Env,
  owner: Owner,
  assetId: string
): Promise<Response> {
  for (const ext of PHOTO_EXTENSIONS) {
    const object = await env.SITES.get(
      `generated/${owner.orgId}/${assetId}.${ext}`
    )
    if (!object) continue
    const headers = {
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    }
    const [forThumb, original] = object.body.tee()
    const thumb = await env.IMAGES?.input(forThumb)
      .transform({ width: THUMB_WIDTH })
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
        "content-type": object.httpMetadata?.contentType ?? `image/${ext}`,
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
