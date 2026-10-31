// @vitest-environment happy-dom
import {
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react"
import type { AskDetailsInput } from "@workspace/contracts"
import { AskDetails } from "@workspace/ui/components/assistant/ask-details"
import { TraySlotProvider } from "@workspace/ui/components/assistant/question-tray"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

/**
 * The assistant set-up's Pick for me keeps what the owner set, the page
 * they are on included before it is saved, and fills only the rest.
 */

const INPUT: AskDetailsInput = {
  step: "assistant",
  prefill: [
    { key: "assistant.name", value: { name: "Ava" } },
    { key: "assistant.pronouns", value: { id: "she_her" } },
    { key: "assistant.avatar", value: { id: "she_1" } },
    { key: "assistant.tone", value: { id: "friendly" } },
  ],
  skippable: false,
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
  HTMLElement.prototype.checkVisibility ??= () => true
})

let unmount: (() => Promise<void>) | undefined
afterEach(async () => {
  await unmount?.()
  unmount = undefined
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

function Chat({ slot, addResult }: { slot: HTMLElement; addResult: unknown }) {
  const runtime = useExternalStoreRuntime({
    messages: [] as ThreadMessageLike[],
    convertMessage: (message: ThreadMessageLike) => message,
    onNew: async () => undefined,
  })
  return createElement(
    AssistantRuntimeProvider,
    { runtime },
    createElement(
      TraySlotProvider,
      { value: slot },
      createElement(AskDetails, {
        toolCallId: "details-call",
        toolName: "ask_details",
        args: INPUT,
        argsText: JSON.stringify(INPUT),
        addResult,
        status: { type: "requires-action", reason: "tool-calls" },
      } as never)
    )
  )
}

it("Pick for me keeps the name being typed and a pick made, and fills the rest", async () => {
  const slot = document.createElement("div")
  const container = document.createElement("div")
  document.body.appendChild(container)
  document.body.appendChild(slot)
  const root = createRoot(container)
  const addResult = vi.fn()
  await act(async () => root.render(createElement(Chat, { slot, addResult })))
  unmount = async () => {
    await act(async () => root.unmount())
    container.remove()
    slot.remove()
  }

  const name = slot.querySelector<HTMLInputElement>("input:not([type=radio])")
  if (!name) throw new Error("No name field")
  name.value = "Sam"
  await act(async () =>
    slot
      .querySelector<HTMLInputElement>(
        'input[name="assistant.tone"][value="casual"]'
      )
      ?.click()
  )
  await act(async () =>
    [...slot.querySelectorAll("button")]
      .find((each) => each.textContent === "Pick for me")
      ?.click()
  )

  expect(addResult).toHaveBeenCalledWith({
    answer: "stated",
    facts: [
      { key: "assistant.name", value: { name: "Sam" } },
      { key: "assistant.pronouns", value: { id: "she_her" } },
      { key: "assistant.avatar", value: { id: "she_1" } },
      { key: "assistant.tone", value: { id: "casual" } },
    ],
    skip_all: true,
  })
})

it("offers each name idea once, Reme first", async () => {
  const slot = document.createElement("div")
  const container = document.createElement("div")
  document.body.appendChild(container)
  document.body.appendChild(slot)
  const root = createRoot(container)
  await act(async () =>
    root.render(createElement(Chat, { slot, addResult: vi.fn() }))
  )
  unmount = async () => {
    await act(async () => root.unmount())
    container.remove()
    slot.remove()
  }

  const ideas = [
    ...slot.querySelectorAll('[aria-label="Name ideas"] button'),
  ].map((each) => each.textContent)
  expect(ideas[0]).toBe("Reme")
  expect(new Set(ideas).size).toBe(ideas.length)
})
