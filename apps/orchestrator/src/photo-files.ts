import type { Asset } from "@workspace/contracts"

/**
 * Where a photo lives and what it is called, in one place: the extension a
 * content type gets, the bucket keys of the owner's uploads and the photo
 * director's pictures, and the paths the site config names them by.
 */

const EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
}

/** The file extension for a content type; an unknown one is a PNG. */
export const extension = (contentType: string) =>
  EXTENSION[contentType] ?? "png"

/** The content type a stored file's extension names; an unknown one is a PNG. */
export const contentTypeOf = (ext: string) =>
  Object.entries(EXTENSION).find(([, e]) => e === ext)?.[0] ?? "image/png"

/**
 * Where `apps/api` stores an owner's photo (its `uploadKey`): the site
 * bucket, under the org.
 */
export const photoKey = (orgId: string, assetId: string) =>
  `uploads/${orgId}/${assetId}`

/** The path the site config names an owner photo by; the file sits under `src/assets/`. */
export const photoFile = (asset: Asset) =>
  `uploads/${asset.id}.${extension(asset.content_type)}`

/** The bucket key a generated picture is stored under, before its extension. */
export const generatedKey = (orgId: string, assetId: string) =>
  `generated/${orgId}/${assetId}`

/** Where generated photos sit in the site; the site config names each by `{dir}/{slot id}.{ext}`. */
export const GENERATED_DIR = "src/assets/generated"

/** Where a generated slot's picture lives in the site, which its site field names. */
export const generatedPath = (slotId: string, contentType: string | null) =>
  `${GENERATED_DIR}/${slotId}.${extension(contentType ?? "")}`

/** A slot's path before its photo exists: what most draws come back as. */
export const plannedPath = (slotId: string) =>
  generatedPath(slotId, "image/jpeg")

/** The stored picture for a generated asset id, and the content type its extension names. */
export async function findGenerated(
  sites: {
    list: (options: {
      prefix: string
    }) => Promise<{ objects: { key: string }[] }>
  },
  orgId: string,
  assetId: string
): Promise<{ key: string; contentType: string } | undefined> {
  const prefix = generatedKey(orgId, assetId)
  const found = (await sites.list({ prefix: `${prefix}.` })).objects[0]
  return found
    ? {
        key: found.key,
        contentType: contentTypeOf(found.key.slice(prefix.length + 1)),
      }
    : undefined
}
