import type { Asset } from "@workspace/contracts"
import { photosAnswerOf } from "@workspace/ui/components/assistant/tray-photos"
import { expect, it } from "vitest"

const photo = (n: number, use?: Asset["use"], usable = true) => ({
  asset: {
    id: `0b6c1e5d-8d2a-4f3b-9c4d-2e1a7b6c5d4${n}`,
    name: `${n}.jpg`,
    content_type: "image/jpeg" as const,
    bytes: 3,
    ...(use ? { use } : {}),
  },
  usable,
  note: usable ? null : "Too dark to use.",
})

const FULL = [
  photo(1, "hero"),
  photo(2, "work"),
  photo(3, "work"),
  photo(4, "work"),
]

it("settles on the photos once every needed one is in, the team photo or not", () => {
  expect(photosAnswerOf(FULL, false)).toEqual({
    photos: FULL.map((each) => each.asset),
    create: false,
  })
  // Create means nothing once nothing is missing.
  expect(photosAnswerOf(FULL, true)?.create).toBe(false)
})

it("has no answer while a needed photo is missing, unless the rest is left to create", () => {
  const some = [photo(1, "hero"), photo(2, "work")]
  expect(photosAnswerOf(some, false)).toBeUndefined()
  expect(photosAnswerOf(some, true)).toEqual({
    photos: some.map((each) => each.asset),
    create: true,
  })
  expect(photosAnswerOf([], true)).toEqual({ photos: [], create: true })
  expect(photosAnswerOf([], false)).toBeUndefined()
})

it("never answers with a photo that cannot be used, nor counts it", () => {
  const dark = photo(5, "hero", false)
  expect(photosAnswerOf([...FULL.slice(1), dark], false)).toBeUndefined()
  expect(photosAnswerOf([...FULL, dark], false)?.photos).not.toContain(
    dark.asset
  )
})
