import { beforeEach, expect, it, vi } from "vitest"

// The server function's own check, with the api behind it stubbed: what it
// forwards is what the api would store.

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (input: unknown) => input
    const builder = {
      validator(next: (input: unknown) => unknown) {
        validate = next
        return builder
      },
      handler:
        (run: (context: { data: unknown }) => unknown) =>
        (options?: { data?: unknown }) =>
          Promise.resolve().then(() => run({ data: validate(options?.data) })),
    }
    return builder
  },
}))
vi.mock("@tanstack/react-start/server", () => ({
  getCookie: () => undefined,
  setCookie: () => undefined,
  getRequestProtocol: () => "https",
}))
const updates = vi.fn(async () => undefined)
vi.mock("./source", () => ({
  source: {
    orgs: async () => [
      {
        id: "9f1c0b52-6d3a-4d0e-8a44-0c1f2b3a4d5e",
        slug: "fixture",
        name: "Fixture",
      },
    ],
    updateConversation: updates,
  },
}))

const { updateConversation } = await import("./server")
const ID = "7d1c2a4e-2f0b-4c8e-9a51-3b6f0e2d9c10"

beforeEach(() => updates.mockClear())

it("keeps a renamed title the way the api keeps it", async () => {
  await updateConversation({
    data: { id: ID, title: `  Saturday${" ".repeat(200)}hours\n`, key: "k" },
  })
  expect(updates).toHaveBeenCalledWith(
    "9f1c0b52-6d3a-4d0e-8a44-0c1f2b3a4d5e",
    ID,
    { title: "Saturday hours" },
    "k"
  )
  // Cut to 120 units before a character, never inside one.
  await updateConversation({
    data: { id: ID, title: `${"a".repeat(119)}🧽`, key: "k" },
  })
  expect(updates).toHaveBeenLastCalledWith(
    expect.any(String),
    ID,
    { title: "a".repeat(119) },
    "k"
  )
})

it("refuses a title with no words before it reaches the api", async () => {
  await expect(
    updateConversation({ data: { id: ID, title: " \n ", key: "k" } })
  ).rejects.toThrow("A title needs words.")
  expect(updates).not.toHaveBeenCalled()
})
