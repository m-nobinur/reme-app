// @vitest-environment happy-dom
import {
  type AppendMessage,
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react"
import { choicesOf } from "@workspace/ui/components/assistant/decision-pills"
import { Thread } from "@workspace/ui/components/assistant/thread"
import { act, createElement, useSyncExternalStore } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

/**
 * Quick replies for the newest decision, above the composer: the
 * recommendation first, a tap sends the fuller message, and they fade once
 * anything newer lands or the owner sends.
 */
;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const CHOICES = [
  { label: "Bought it", send: "I've bought brightwaycleaning.co.uk" },
  { label: "Not yet", send: "I haven't bought brightwaycleaning.co.uk yet" },
]

const offer = (id: string): ThreadMessageLike => ({
  id,
  role: "assistant",
  content: [
    { type: "text", text: "Did you manage to buy brightwaycleaning.co.uk?" },
    {
      type: "tool-call",
      toolCallId: `call_${id}`,
      toolName: "offer_choices",
      args: { choices: CHOICES },
      argsText: JSON.stringify({ choices: CHOICES }),
      result: { outcome: "offered" },
    },
  ],
  status: { type: "complete", reason: "stop" },
})

const said = (
  id: string,
  role: "user" | "assistant",
  text: string
): ThreadMessageLike => ({
  id,
  role,
  content: [{ type: "text", text }],
  ...(role === "assistant" && {
    status: { type: "complete" as const, reason: "stop" as const },
  }),
})

let state: { messages: ThreadMessageLike[]; isRunning: boolean }
const listeners = new Set<() => void>()
const set = (next: typeof state) =>
  act(async () => {
    state = next
    for (const listener of listeners) listener()
  })

let root: Root | undefined
let container: HTMLDivElement
let sent: AppendMessage[]

function Chat() {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state
  )
  const runtime = useExternalStoreRuntime({
    messages: current.messages,
    isRunning: current.isRunning,
    convertMessage: (message: ThreadMessageLike) => message,
    onNew: async (message) => {
      sent.push(message)
    },
  })
  return createElement(
    AssistantRuntimeProvider,
    { runtime },
    createElement(Thread, { autoFocus: false })
  )
}

async function mount(messages: ThreadMessageLike[]) {
  state = { messages, isRunning: false }
  container = document.createElement("div")
  document.body.appendChild(container)
  const made = createRoot(container)
  root = made
  await act(async () => made.render(createElement(Chat)))
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = () => undefined
      unobserve = () => undefined
      disconnect = () => undefined
    }
  )
  Element.prototype.scrollTo ??= () => undefined
  sent = []
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  container?.remove()
  vi.unstubAllGlobals()
})

const pills = () => [
  ...container.querySelectorAll<HTMLButtonElement>(
    '[data-slot="reply-pills"] button'
  ),
]
const row = () =>
  container.querySelector('[data-slot="reply-pills"]')?.parentElement ?? null

it("reads choices from a posted notice's part or the CoS's call, and nothing else", () => {
  expect(choicesOf([{ type: "data", name: "choices", data: CHOICES }])).toEqual(
    CHOICES
  )
  expect(choicesOf(offer("a1").content as object[])).toEqual(CHOICES)
  expect(choicesOf([{ type: "data", name: "choices", data: [] }])).toBeNull()
  expect(
    choicesOf([
      { type: "tool-call", toolName: "offer_choices", args: { choices: [] } },
    ])
  ).toBeNull()
  expect(choicesOf([{ type: "text", text: "Hi" }])).toBeNull()
  expect(choicesOf(undefined)).toBeNull()
})

it("shows the newest decision's pills, the recommendation first and named so", async () => {
  await mount([said("u1", "user", "Hi"), offer("a1")])
  await vi.waitFor(() => expect(pills()).toHaveLength(2))
  const [first, second] = pills()
  expect(first?.textContent).toBe("Bought it, recommended")
  expect(first?.dataset.recommended).toBe("true")
  expect(second?.textContent).toBe("Not yet")
  expect(second?.dataset.recommended).toBeUndefined()
  expect(
    container.querySelector('[data-slot="reply-pills"] legend')?.textContent
  ).toBe("Quick replies")
})

it("marks no recommendation on a lone pill, as a stopped build's notice posts it", async () => {
  await mount([
    {
      id: "srv_1",
      role: "assistant",
      content: [
        { type: "text", text: "Your website build couldn't finish." },
        {
          type: "data",
          name: "choices",
          data: [
            { label: "Try again", send: "Try building my website again." },
          ],
        },
      ],
      status: { type: "complete", reason: "stop" },
    },
  ])
  await vi.waitFor(() => expect(pills()).toHaveLength(1))
  expect(pills()[0]?.textContent).toBe("Try again")
  expect(pills()[0]?.dataset.recommended).toBeUndefined()
})

it("sends the pill's fuller message as the owner's, not its label", async () => {
  await mount([offer("a1")])
  await vi.waitFor(() => expect(pills()).toHaveLength(2))
  await act(async () => pills()[1]?.click())
  await vi.waitFor(() => expect(sent).toHaveLength(1))
  expect(sent[0]?.content).toEqual([
    { type: "text", text: "I haven't bought brightwaycleaning.co.uk yet" },
  ])
})

it("fades out when the owner sends anything, then leaves", async () => {
  await mount([offer("a1")])
  await vi.waitFor(() => expect(pills()).toHaveLength(2))
  await set({
    messages: [offer("a1"), said("u2", "user", "What about the logo?")],
    isRunning: true,
  })
  expect(row()?.getAttribute("data-away")).toBe("true")
  expect(row()?.className).toContain("opacity-0")
  expect(row()?.className).toContain("motion-reduce:transition-none")
  await vi.waitFor(() => expect(row()).toBeNull())
})

it("fades out when a newer message lands, an update that asks nothing included", async () => {
  await mount([offer("a1")])
  await vi.waitFor(() => expect(pills()).toHaveLength(2))
  await set({
    messages: [offer("a1"), said("srv_2", "assistant", "Your draft is ready.")],
    isRunning: false,
  })
  expect(row()?.getAttribute("data-away")).toBe("true")
  await vi.waitFor(() => expect(row()).toBeNull())
})

it("after a reload, shows them only while their message is still the last", async () => {
  await mount([offer("a1"), said("u2", "user", "Not yet")])
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
  expect(pills()).toHaveLength(0)
})

it("shows only the newest decision's pills when two were offered", async () => {
  const older = {
    ...offer("a1"),
    content: [
      {
        type: "data" as const,
        name: "choices",
        data: [{ label: "Try again", send: "Try building my website again." }],
      },
    ],
  }
  await mount([older, said("u2", "user", "Hi"), offer("a3")])
  await vi.waitFor(() => expect(pills()).toHaveLength(2))
  expect(pills().map((p) => p.textContent)).toEqual([
    "Bought it, recommended",
    "Not yet",
  ])
})
