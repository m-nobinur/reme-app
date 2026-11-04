// @vitest-environment happy-dom
import {
  type AssistantRuntime,
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react"
import { RECAP_REPLY } from "@workspace/contracts"
import { Thread } from "@workspace/ui/components/assistant/thread"
import { act, createElement, useSyncExternalStore } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

/**
 * Quick replies under a reply that is still typing in: the stream has ended,
 * but the words reveal for a moment after it. The pills wait for them, then
 * fade in together and take the focus, unless the owner is typing.
 */
;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const WORDS =
  "Here's what I've noted for Pruning Co: tree pruning and crown reductions, tree felling, hedge trimming and stump grinding, around Leeds and about 20 miles out."

const recap = (text: string, done: boolean): ThreadMessageLike => ({
  id: "msg_recap",
  role: "assistant",
  content: [
    { type: "text", text },
    ...(done
      ? [
          {
            type: "tool-call" as const,
            toolCallId: "call_recap",
            toolName: "ask_open",
            args: { about: "recap" },
            argsText: '{"about":"recap"}',
          },
        ]
      : []),
  ],
  status: done
    ? { type: "requires-action", reason: "tool-calls" }
    : { type: "running" },
})

let state: { messages: ThreadMessageLike[]; isRunning: boolean }
const listeners = new Set<() => void>()
const set = (next: typeof state) =>
  act(async () => {
    state = next
    for (const listener of listeners) listener()
  })

let root: Root
let container: HTMLDivElement
let runtime: AssistantRuntime | undefined

// The reveal runs on animation frames and `performance.now`; both are held
// here and moved by the test, so how fast the runner is cannot decide whether
// the words are still typing when the stream ends.
let clock = 0
const frames = new Map<number, FrameRequestCallback>()
let frameId = 0
const advance = (ms: number) =>
  act(async () => {
    clock += ms
    const due = [...frames.values()]
    frames.clear()
    for (const frame of due) frame(clock)
  })
/** Moves the clock on, a quarter second a step, until `check` holds. */
const until = (check: () => boolean) =>
  vi.waitFor(
    async () => {
      await advance(250)
      expect(check()).toBe(true)
    },
    { timeout: 5000 }
  )

function Chat() {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state
  )
  runtime = useExternalStoreRuntime({
    messages: current.messages,
    isRunning: current.isRunning,
    convertMessage: (message: ThreadMessageLike) => message,
    onNew: async () => undefined,
  })
  return createElement(
    AssistantRuntimeProvider,
    { runtime },
    createElement(Thread, { autoFocus: false })
  )
}

beforeEach(async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = () => undefined
      unobserve = () => undefined
      disconnect = () => undefined
    }
  )
  Element.prototype.scrollTo ??= () => undefined
  clock = 0
  frames.clear()
  vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => {
    frames.set(++frameId, frame)
    return frameId
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id))
  vi.spyOn(performance, "now").mockImplementation(() => clock)
  state = {
    messages: [
      {
        id: "u1",
        role: "user",
        content: [{ type: "text", text: "0113 496 0123" }],
      },
      recap(WORDS.slice(0, 12), false),
    ],
    isRunning: true,
  }
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(createElement(Chat)))
  // The first words are on screen when the stream ends.
  await until(
    () =>
      container.querySelector(".aui-md")?.textContent ===
      WORDS.slice(0, 12).trim()
  )
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const pills = () =>
  container.querySelector<HTMLFieldSetElement>('[data-slot="reply-pills"]')
const typing = () =>
  container.querySelector('.aui-md[data-status="running"]') !== null

it("waits for the words to type in, then fades every pill in at once and focuses the first", async () => {
  // The stream ends with most of the words still to show.
  await set({
    messages: [state.messages[0] as ThreadMessageLike, recap(WORDS, true)],
    isRunning: false,
  })
  expect(typing()).toBe(true)
  expect(pills()?.className).toContain("invisible")
  expect(document.activeElement).toBe(document.body)

  await until(() => !typing())
  await until(() => pills()?.className.includes("motion-safe:fade-in") ?? false)
  expect(pills()?.className).not.toContain("invisible")
  // One fade on the group, none per pill: no stagger.
  for (const pill of pills()?.querySelectorAll("button") ?? []) {
    expect(pill.className).not.toMatch(/animate-in|delay-/)
  }
  await until(() => document.activeElement?.textContent === RECAP_REPLY)
})

it("leaves the focus in the composer while the owner is typing there", async () => {
  const composer = container.querySelector("textarea") as HTMLTextAreaElement
  await act(async () => {
    composer.focus()
    runtime?.thread.composer.setText("Actually the area")
  })
  await set({
    messages: [state.messages[0] as ThreadMessageLike, recap(WORDS, true)],
    isRunning: false,
  })
  await until(() => pills()?.className.includes("motion-safe:fade-in") ?? false)
  // A task later, when the pills would have taken it.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
  expect(document.activeElement).toBe(composer)
  expect(composer.value).toBe("Actually the area")
})
