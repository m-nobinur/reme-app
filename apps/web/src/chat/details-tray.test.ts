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
 * The assistant set-up's Pick for me keeps what the owner set, a pick on a
 * page not saved yet included, and fills the rest: the empty name with the
 * first name idea.
 */

const INPUT: AskDetailsInput = {
  step: "assistant",
  prefill: [
    { key: "assistant.pronouns", value: { id: "she_her" } },
    { key: "assistant.avatar", value: { id: "she_1" } },
    { key: "assistant.tone", value: { id: "friendly" } },
  ],
  skippable: false,
  ideas: ["Poppy", "Hannah", "Rosa"],
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

it("Pick for me fills the empty name with the first idea and keeps a pick made", async () => {
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
      { key: "assistant.name", value: { name: "Poppy" } },
      { key: "assistant.pronouns", value: { id: "she_her" } },
      { key: "assistant.avatar", value: { id: "she_1" } },
      { key: "assistant.tone", value: { id: "casual" } },
    ],
    skip_all: true,
    changed: ["assistant.tone"],
  })
})

it("Done names only the values the owner changed from the card's defaults", async () => {
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
  const press = (label: string) =>
    act(async () =>
      [...slot.querySelectorAll("button")]
        .find((each) => each.textContent === label)
        ?.click()
    )

  await press("Hannah")
  await press("Next")
  await press("Next")
  await press("Next")
  await press("Done")

  expect(addResult).toHaveBeenCalledWith({
    answer: "stated",
    facts: [
      { key: "assistant.name", value: { name: "Hannah" } },
      { key: "assistant.pronouns", value: { id: "she_her" } },
      { key: "assistant.avatar", value: { id: "she_1" } },
      { key: "assistant.tone", value: { id: "friendly" } },
    ],
    changed: ["assistant.name"],
  })
})

it("offers the three names written for the business", async () => {
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
  expect(ideas).toEqual(["Poppy", "Hannah", "Rosa"])
})
