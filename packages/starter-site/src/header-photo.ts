import { hasPhoto } from "./photo-files"
import { site } from "./site-config"
import { serviceItems } from "./structured-data"

type Photo = { src: string; alt: string }

/**
 * The photo each inner page's header shows, by page: "about", "contact" or
 * "service:<id>". A service header takes its own photo, never its card's. A
 * header takes its photo only when the build has the file and an alt for it,
 * and never a photo the home hero or an earlier header already shows: two
 * pages' first screens must not be the same picture.
 */
const photos = new Map<string, Photo>()
const shown = new Set([site.heroImage])
const candidates: [string, Photo][] = [
  ["about", { src: site.aboutImage, alt: site.aboutImageAlt }],
  ["contact", { src: site.contactImage, alt: site.contactImageAlt }],
  ...serviceItems.map((item): [string, Photo] => [
    `service:${item.id}`,
    item.headerImage,
  ]),
]
for (const [key, photo] of candidates) {
  if (!photo.alt || !hasPhoto(photo.src) || shown.has(photo.src)) continue
  shown.add(photo.src)
  photos.set(key, photo)
}

export const headerPhoto = (key: string): Photo | undefined => photos.get(key)
