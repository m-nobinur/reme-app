import { expect, it, vi } from "vitest"

const updates = vi.fn(async () => undefined)
vi.mock("@/lib/api/server", () => ({
  createConversation: vi.fn(),
  getConversation: vi.fn(),
  getConversationMessages: vi.fn(),
  listConversations: vi.fn(),
  updateConversation: updates,
}))

const { conversationList } = await import("./conversations")
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
