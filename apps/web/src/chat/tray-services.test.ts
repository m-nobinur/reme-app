import { afterEach, expect, it, vi } from "vitest"
import { trayServices } from "./tray-services"

const ID = "0b6c1e5d-8d2a-4f3b-9c4d-2e1a7b6c5d4e"

afterEach(() => {
  vi.unstubAllGlobals()
})

it("sends the photos to review with a key, and reads the review", async () => {
  const seen: { url: string; init: RequestInit | undefined }[] = []
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    seen.push({ url, init })
    return Response.json({ photos: [], missing: [{ need: "hero", count: 1 }] })
  })
  const review = await trayServices.reviewPhotos([ID])
  expect(review.missing).toEqual([{ need: "hero", count: 1 }])
  expect(seen[0]?.url).toBe("/api/assets/review")
  expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ asset_ids: [ID] })
  expect(new Headers(seen[0]?.init?.headers).get("idempotency-key")).toMatch(
    /^[0-9a-f-]{36}$/
  )
})

it("throws the api's own sentence when it refuses", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json(
      {
        class: "resource",
        code: "logo.limit",
        message: "That is all the logos for today. Try again tomorrow.",
        occurred_at: "2026-10-23T09:00:00Z",
        detail: {},
      },
      { status: 429 }
    )
  )
  await expect(trayServices.keepLogo(ID)).rejects.toThrow(
    "That is all the logos for today. Try again tomorrow."
  )
})

it("never hands a page an answer it could not read", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ rounds: "no" }))
  await expect(trayServices.logoRounds("call_1")).rejects.toThrow(
    "That did not come back as expected. Try again."
  )
})
