// @vitest-environment happy-dom
import { Approval } from "@workspace/ui/components/assistant/approval"
import { CosToolsProvider } from "@workspace/ui/components/assistant/cos-tools"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

// The card reads the thread through assistant-ui's store; this stands in for
// it, since what is checked is the card, not the runtime.
const store = vi.hoisted(() => ({ isLast: true }))
vi.mock("@assistant-ui/react", async (original) => ({
  ...(await original<typeof import("@assistant-ui/react")>()),
  useAuiState: (select: (state: unknown) => unknown) =>
    select({
      message: { parts: [], isLast: store.isLast, status: undefined },
      thread: { isRunning: false, messages: [] },
    }),
  useAui: () => ({ thread: () => ({ append: vi.fn() }) }),
  useThreadViewport: () => undefined,
}))

const ID = "6f1c2c36-1d3e-4f5a-9b7c-2a1d4e5f6a7b"

/** The buttons on a set reminder's card, with `open` the workspace's open reminders. */
async function buttons(open: readonly string[] | undefined) {
  const container = document.createElement("div")
  const root = createRoot(container)
  await act(async () =>
    root.render(
      createElement(
        CosToolsProvider,
        {
          value: {
            zone: "Europe/London",
            question: () => null,
            removeReminder: async () => ({ done: true }),
            ...(open && { reminderOpen: (id: string) => open.includes(id) }),
          },
        },
        createElement(Approval, {
          toolName: "create_reminder",
          toolCallId: "call-1",
          args: { title: "Call Sam", due_at: null },
          argsText: "",
          result: { outcome: "created", reminder_id: ID, due_at: null },
        } as never)
      )
    )
  )
  const found = [...container.querySelectorAll("button")].map((b) =>
    b.textContent?.trim()
  )
  await act(async () => root.unmount())
  return found
}

it("offers Undo on an older card only while its reminder is still open", async () => {
  store.isLast = false
  expect(await buttons([ID])).toEqual(["Undo"])
  expect(await buttons([])).toEqual([])
  // Before the workspace is read, every reminder is taken as open.
  expect(await buttons(undefined)).toEqual(["Undo"])
})

it("keeps Undo on the newest card before the workspace has read the reminder", async () => {
  store.isLast = true
  expect(await buttons([])).toEqual(["Undo"])
})
