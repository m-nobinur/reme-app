import { checkPhotos, sizeText, typesText } from "@workspace/ui/lib/upload"
import { expect, it } from "vitest"

const LIMITS = {
  accept: ["image/jpeg", "image/png", "image/webp"] as const,
  max_bytes: 5 * 1024 * 1024,
  max_files: 2,
}
const photo = (name: string, type = "image/jpeg", size = 1000) => ({
  name,
  type,
  size,
})

it("names the limits the way the owner reads them", () => {
  expect(typesText(LIMITS.accept)).toBe("JPEG, PNG or WebP")
  expect(typesText(["image/png"])).toBe("PNG")
  expect(sizeText(LIMITS.max_bytes)).toBe("5 MB")
  expect(sizeText(1500)).toBe("2 KB")
})

it("keeps what the api would take and says why it left out the rest", () => {
  const kept = [photo("one.jpg")]
  const { kept: next, refused } = checkPhotos(
    kept,
    [
      photo("logo.svg", "image/svg+xml"),
      photo("huge.jpg", "image/jpeg", LIMITS.max_bytes + 1),
      photo("two.png", "image/png"),
      photo("three.webp", "image/webp"),
    ],
    { ...LIMITS, accept: [...LIMITS.accept] }
  )
  expect(next.map((each) => each.name)).toEqual(["one.jpg", "two.png"])
  expect(refused).toEqual([
    "logo.svg is not a JPEG, PNG or WebP photo.",
    "huge.jpg is over 5 MB. Send a smaller copy.",
    "three.webp was left out: 2 photos is the most at once.",
  ])
})

it("takes a photo exactly at the size limit", () => {
  expect(
    checkPhotos([], [photo("edge.jpg", "image/jpeg", LIMITS.max_bytes)], {
      ...LIMITS,
      accept: [...LIMITS.accept],
    }).kept
  ).toHaveLength(1)
})
