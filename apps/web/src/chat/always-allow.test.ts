// @vitest-environment happy-dom
import { Approval } from "@workspace/ui/components/assistant/approval"
import { AlwaysAllowProvider } from "@workspace/ui/components/assistant/decision"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

// The card reads the thread through assistant-ui's store; this stands in for
// it, since what is checked is the card, not the runtime.
vi.mock("@assistant-ui/react", async (original) => ({
  ...(await original<typeof import("@assistant-ui/react")>()),
  useAuiState: (select: (state: unknown) => unknown) =>
    select({
      message: { parts: [], isLast: true, status: undefined },
      thread: { isRunning: false, messages: [] },
    }),
  useAui: () => ({ thread: () => ({ append: vi.fn() }) }),
  useThreadViewport: () => undefined,
}))

const REVIEW = { slot: 1, quote: "Spotless.", name: "Ann", permission: true }

/** A card waiting on the owner, its buttons, and what a press of `press` sent. */
async function card(toolName: string, args: unknown, press?: string) {
  const container = document.createElement("div")
  const root = createRoot(container)
  const tapped: string[] = []
  const respondToApproval = vi.fn()
  await act(async () =>
    root.render(
      createElement(
        AlwaysAllowProvider,
        { value: (id: string) => void tapped.push(id) },
        createElement(Approval, {
          toolName,
          toolCallId: "call-1",
          args,
          argsText: "",
          status: { type: "requires-action", reason: "tool-calls" },
          approval: { id: "appr_1" },
          respondToApproval,
        } as never)
      )
    )
  )
  const buttons = [...container.querySelectorAll("button")]
  const labels = buttons.map((b) => b.textContent?.trim())
  const button = buttons.find((b) => b.textContent?.trim() === press)
  if (press) await act(async () => button?.click())
  await act(async () => root.unmount())
  return { labels, tapped, sent: respondToApproval.mock.calls }
}

it("offers Always allow beside the yes on a grantable card, and the tap saves it with the yes", async () => {
  const shown = await card("record_review", REVIEW)
  expect(shown.labels).toContain("Always allow")
  const tapped = await card("record_review", REVIEW, "Always allow")
  expect(tapped.tapped).toEqual(["appr_1"])
  expect(tapped.sent).toEqual([[{ approved: true }]])
  const yes = await card("record_review", REVIEW, "They agreed, save it")
  expect(yes.tapped).toEqual([])
  expect(yes.sent).toEqual([[{ approved: true }]])
})

it("offers no Always allow on a card that always asks", async () => {
  const { labels } = await card("remove_domain", { name: "sparkleclean.co.uk" })
  expect(labels).not.toContain("Always allow")
})

it("saves the grant with the offer card's yes, and its no saves nothing", async () => {
  const offer = { kind: "record_review" }
  const shown = await card("offer_grant", offer)
  expect(shown.labels).not.toContain("Always allow")
  expect((await card("offer_grant", offer, "Don't ask me")).tapped).toEqual([
    "appr_1",
  ])
  const no = await card("offer_grant", offer, "Keep asking")
  expect(no.tapped).toEqual([])
  expect(no.sent).toEqual([[{ approved: false }]])
})
