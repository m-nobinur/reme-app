import { expect, it } from "vitest"
import { uploadPhotos } from "./upload"

const ASSET = {
  id: "0b6c1e5d-8d2a-4f3b-9c4d-2e1a7b6c5d4e",
  name: "van.jpg",
  content_type: "image/jpeg",
  bytes: 3,
}

it("sends every photo as `files` with a key, and reads what was stored", async () => {
  const seen: { url: string; init: RequestInit | undefined }[] = []
  const stored = await uploadPhotos(
    [new File(["abc"], "van.jpg", { type: "image/jpeg" })],
    async (url, init) => {
      seen.push({ url: String(url), init })
      return Response.json({ assets: [ASSET] }, { status: 201 })
    }
  )
  expect(stored).toEqual({ assets: [ASSET] })
  expect(seen[0]?.url).toBe("/api/assets")
  const body = seen[0]?.init?.body as FormData
  expect(body.getAll("files").map((file) => (file as File).name)).toEqual([
    "van.jpg",
  ])
  expect(new Headers(seen[0]?.init?.headers).get("idempotency-key")).toMatch(
    /^[0-9a-f-]{36}$/
  )
})

it("never answers the card with an answer it could not read", async () => {
  await expect(
    uploadPhotos([], async () => Response.json({ assets: [] }))
  ).rejects.toThrow("Reload before you send them again.")
})
