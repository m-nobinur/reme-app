/**
 * The site's pictures: the owner's uploads (src/assets/uploads/) and the
 * photo director's (src/assets/generated/), by the path the site config
 * names them with, "/uploads/<id>.jpg" or "src/assets/generated/<slot>.png".
 * Lazy, so only a photo a page names is imported: an eager glob makes Astro
 * emit every original beside its resized variants.
 */
const files = import.meta.glob<{ default: ImageMetadata }>(
  "/src/assets/**/*.{jpg,jpeg,png,webp,avif}"
)

/** The loader for the file a site field names, or undefined when there is none. */
export const photoFile = (src: string) =>
  files[`/src/assets/${src.replace(/^\/?(?:src\/assets\/)?/, "")}`]

/** Whether a site field names a picture the build has. */
export const hasPhoto = (src: string) => Boolean(src && photoFile(src))
