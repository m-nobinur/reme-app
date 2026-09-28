import type { Thumbnail } from "@workspace/ui/components/live-panel"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { PreviewLinks } from "./api/types"
import {
  followThumbnail,
  REFRESH_BEFORE_EXPIRY,
  REFRESH_FLOOR,
  type ThumbnailFollower,
} from "./thumbnail"

const BUILD = "00000000-0000-4000-8000-000000000003"
const V3 = {
  revisionId: "00000000-0000-4000-8000-000000000013",
  assignmentId: BUILD,
}
const V4 = {
  revisionId: "00000000-0000-4000-8000-000000000014",
  assignmentId: BUILD,
}
const HOUR = 60 * 60_000

/** A preview of `revisionId` whose links lapse `ttl` from now. */
const link = (revisionId: string, ttl = 24 * HOUR): PreviewLinks => ({
  revisionId,
  url: "https://preview-v3-fictional.example.invalid/open?t=a",
  screenshots: ["390", "768", "1440"].map(
    (w) =>
      `https://preview-v3-fictional.example.invalid/home-${w}.png?t=${revisionId}`
  ),
  expiresAt: new Date(Date.now() + ttl).toISOString(),
})

let answers: (PreviewLinks | null | Error)[]
let reads: string[]
let shown: Thumbnail[]
let follower: ThumbnailFollower

beforeEach(() => {
  vi.useFakeTimers()
  answers = []
  reads = []
  shown = []
  follower = followThumbnail({
    read: async (assignmentId) => {
      reads.push(assignmentId)
      const next = answers.shift() ?? null
      if (next instanceof Error) throw next
      return next
    },
    onChange: (thumbnail) => shown.push(thumbnail),
  })
})

afterEach(() => {
  follower.stop()
  vi.useRealTimers()
})

const settle = () => vi.advanceTimersByTimeAsync(0)

it("shows the desktop screenshot of the live revision", async () => {
  answers.push(link(V3.revisionId))
  follower.show(V3)
  await settle()
  expect(reads).toEqual([BUILD])
  expect(shown).toEqual([
    "loading",
    {
      src: `https://preview-v3-fictional.example.invalid/home-1440.png?t=${V3.revisionId}`,
    },
  ])
})

it("does not read the same revision again", async () => {
  answers.push(link(V3.revisionId))
  follower.show(V3)
  await settle()
  follower.show({ ...V3 })
  await settle()
  expect(reads).toHaveLength(1)
  expect(shown).toHaveLength(2)
})

it("reads again when a new revision goes live", async () => {
  answers.push(link(V3.revisionId), link(V4.revisionId))
  follower.show(V3)
  await settle()
  follower.show(V4)
  await settle()
  expect(reads).toHaveLength(2)
  expect(shown.at(-1)).toEqual({
    src: expect.stringContaining(V4.revisionId),
  })
})

it("reads again before the links expire, and not before that", async () => {
  answers.push(link(V3.revisionId, HOUR), link(V3.revisionId, HOUR))
  follower.show(V3)
  await settle()
  await vi.advanceTimersByTimeAsync(HOUR - REFRESH_BEFORE_EXPIRY - 1)
  expect(reads).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(reads).toHaveLength(2)
  // The image stays up while the fresh links are read.
  expect(shown.filter((thumbnail) => thumbnail === "loading")).toHaveLength(1)
})

it("waits a minute before reading links that are already close to expiry", async () => {
  answers.push(
    link(V3.revisionId, REFRESH_BEFORE_EXPIRY),
    link(V3.revisionId, REFRESH_BEFORE_EXPIRY)
  )
  follower.show(V3)
  await settle()
  await vi.advanceTimersByTimeAsync(REFRESH_FLOOR - 1)
  expect(reads).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(reads).toHaveLength(2)
})

it("shows nothing when the preview is of another revision", async () => {
  answers.push(link(V4.revisionId))
  follower.show(V3)
  await settle()
  expect(shown).toEqual(["loading", null])
})

it("shows nothing when the read fails", async () => {
  answers.push(new Error("offline"))
  follower.show(V3)
  await settle()
  expect(shown).toEqual(["loading", null])
})

it("drops a read that lands after the live revision changed", async () => {
  let answerV3: (value: PreviewLinks) => void = () => undefined
  follower = followThumbnail({
    read: (assignmentId) => {
      reads.push(assignmentId)
      return reads.length === 1
        ? new Promise((resolve) => {
            answerV3 = resolve
          })
        : Promise.resolve(link(V4.revisionId))
    },
    onChange: (thumbnail) => shown.push(thumbnail),
  })
  follower.show(V3)
  follower.show(V4)
  await settle()
  answerV3(link(V3.revisionId))
  await settle()
  expect(shown.at(-1)).toEqual({ src: expect.stringContaining(V4.revisionId) })
})
