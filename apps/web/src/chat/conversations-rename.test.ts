import { expect, it, vi } from "vitest"

const updates = vi.fn(async () => undefined)
const fetched = vi.fn(async () => null)
const read = vi.fn(async () => [])
vi.mock("@/lib/api/server", () => ({
  createConversation: vi.fn(),
  getConversation: fetched,
  getConversationMessages: read,
  listConversations: vi.fn(),
  updateConversation: updates,
}))

const { conversationList, readMessages, seedOpening } = await import(
  "./conversations"
)
const ID = "7d1c2a4e-2f0b-4c8e-9a51-3b6f0e2d9c10"

it("renames through the thread list by the same rule as the top bar", async () => {
  await conversationList.rename(ID, `  Saturday\n\n   hours `)
  expect(updates).toHaveBeenCalledWith({
    data: { id: ID, title: "Saturday hours" },
  })
  await expect(conversationList.rename(ID, "   ")).rejects.toThrow(
    "A title needs words."
  )
  expect(updates).toHaveBeenCalledTimes(1)
})

it("serves the loader's conversation and rows once, then reads them again", async () => {
  const opening = {
    conversation: {
      id: ID,
      kind: "onboarding",
      title: "Getting started",
      archived_at: null,
      created_at: new Date().toISOString(),
    },
    messages: [{ id: "m1" }],
  } as unknown as Parameters<typeof seedOpening>[0]
  seedOpening(opening)
  expect(await conversationList.fetch(ID)).toMatchObject({
    remoteId: ID,
    title: "Getting started",
  })
  expect(await readMessages(ID)).toEqual([{ id: "m1" }])
  expect(fetched).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()

  seedOpening(opening)
  expect(await readMessages(ID)).toEqual([])
  expect(read).toHaveBeenCalledWith({ data: { id: ID } })
})
