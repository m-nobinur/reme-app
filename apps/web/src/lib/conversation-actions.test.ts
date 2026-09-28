import { expect, it, vi } from "vitest"
import {
  archiveConversation,
  saveTitle,
  titleToEdit,
} from "./conversation-actions"

const ID = "7d1c2a4e-2f0b-4c8e-9a51-3b6f0e2d9c10"

it("leaves an archived conversation only if the owner is still on it", async () => {
  for (const [stillOn, left] of [
    [true, 1],
    [false, 0],
  ] as const) {
    const leave = vi.fn(async () => undefined)
    const archived = await archiveConversation(ID, {
      update: async () => undefined,
      stillOn: () => stillOn,
      leave,
    })
    expect(archived).toBe(true)
    expect(leave).toHaveBeenCalledTimes(left)
  }
})

it("stays put and says so when the archive fails", async () => {
  const leave = vi.fn(async () => undefined)
  const archived = await archiveConversation(ID, {
    update: () => Promise.reject(new Error("503")),
    stillOn: () => true,
    leave,
  })
  expect(archived).toBe(false)
  expect(leave).not.toHaveBeenCalled()
})

it("saves only a title that changed", async () => {
  const update = vi.fn(async () => undefined)
  await saveTitle({ id: ID, title: "Weekend prices" }, "Weekend prices", update)
  expect(update).not.toHaveBeenCalled()
  // An untitled conversation keeps no title until one is typed.
  await saveTitle({ id: ID, title: null }, "Saturday hours", update)
  expect(update).toHaveBeenCalledWith(ID, "Saturday hours")
})

it("starts a rename from the stored title, never the label an untitled one shows", () => {
  expect(titleToEdit({ title: "Weekend prices" })).toBe("Weekend prices")
  expect(titleToEdit({ title: null })).toBe("")
})
