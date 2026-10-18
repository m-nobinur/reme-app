import { afterEach, expect, it, vi } from "vitest"

const server = vi.hoisted(() => ({
  askForChanges: vi.fn(async () => ({ done: true })),
}))
vi.mock("@/lib/api/server", () => server)

const { photoActions } = await import("./photo-actions")

const PHOTO = {
  alt: "A tidy kitchen",
  slot_id: "hero-1",
  section: "hero",
} as Parameters<ReturnType<typeof photoActions>["onUseOwn"]>[0]
const ASSET = "6a0c1f2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b"

afterEach(() => {
  vi.unstubAllGlobals()
  server.askForChanges.mockClear()
})

async function useOwn(response: Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response)
  )
  let outcome: unknown
  photoActions((write) => {
    outcome = write()
  }).onUseOwn(PHOTO, new File(["x"], "kitchen.jpg", { type: "image/jpeg" }))
  return await outcome
}

it("names the uploaded asset in the change it asks for", async () => {
  await useOwn(
    Response.json(
      { assets: [{ id: ASSET, name: "kitchen.jpg" }] },
      { status: 201 }
    )
  )
  const [call] = server.askForChanges.mock.calls as unknown as [
    [{ data: { text: string } }],
  ]
  expect(call[0].data.text).toContain(`(asset ${ASSET})`)
})

it("asks for nothing when the upload fails", async () => {
  expect(await useOwn(new Response(null, { status: 413 }))).toMatchObject({
    done: false,
  })
  expect(server.askForChanges).not.toHaveBeenCalled()
})
