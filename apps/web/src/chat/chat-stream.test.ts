// @vitest-environment happy-dom
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  AssistantRuntimeProvider,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react"
import { ChatRequest } from "@workspace/contracts"
import { Approval } from "@workspace/ui/components/assistant/approval"
import { Thread } from "@workspace/ui/components/assistant/thread"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { conversationList } from "./conversations"
import { useConversationRuntime } from "./runtime"

/**
 * The chat as the owner's browser runs it: the AI SDK chat, assistant-ui's
 * runtime and converter, the thread, and the owner's cards, fed the history
 * and the `/chat` streams `apps/api` actually wrote (recorded in
 * `fixtures/onboarding-chat.json`). A regression in the converter, the card
 * dispatch or the part grouping fails here, in a blocking suite.
 */

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
  getCookie: (name: string) => (name === "wos-session" ? "sealed" : undefined),
  setCookie: () => undefined,
  getRequestProtocol: () => "https",
}))

// React's act() warns without this; the approval test renders the same way.
;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

type Stream = { request: unknown; response: string }
const FIXTURE = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "fixtures/onboarding-chat.json"
    ),
    "utf8"
  )
) as {
  org: unknown
  list: unknown
  conversation: { id: string }
  histories: Record<
    "start" | "typed" | "name" | "pricing" | "offered" | "denied" | "change",
    unknown
  >
  streams: Record<"typed" | "name" | "skip" | "deny" | "change", Stream>
}
const ID = FIXTURE.conversation.id

/** What the api holds now, and how it answers the next `/chat` turns. */
let stored: unknown
let turns: (() => Promise<Response>)[] = []
let sent: unknown[] = []
/** Holds the api's reads until released, to see the thread while it loads. */
let hold: Promise<void> | null = null

const sse = (stream: Stream) => () =>
  Promise.resolve(
    new Response(stream.response, {
      headers: { "content-type": "text/event-stream" },
    })
  )
const refusal = (status: number, code: string, message: string) => () =>
  Promise.resolve(
    Response.json(
      {
        class: status === 409 || status === 400 ? "validation" : "transient",
        code,
        message,
        detail: {},
        occurred_at: "2026-09-27T10:00:00.000Z",
      },
      { status }
    )
  )

beforeEach(() => {
  process.env.REME_API_URL = "https://api.test"
  sent = []
  turns = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.endsWith("/api/chat")) {
        sent.push(JSON.parse(String(init?.body)))
        const next = turns.shift()
        if (!next) throw new Error("no /chat answer queued")
        return next()
      }
      const path = new URL(url).pathname
      if (hold && path.startsWith("/conversations")) await hold
      if (path === "/org") return Response.json(FIXTURE.org)
      if (path === "/conversations") return Response.json(FIXTURE.list)
      if (path === `/conversations/${ID}`) {
        return Response.json(FIXTURE.conversation)
      }
      if (path === `/conversations/${ID}/messages`) {
        return Response.json(stored)
      }
      throw new Error(`unexpected fetch ${url}`)
    })
  )
  // What happy-dom leaves out and the thread viewport reads.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = () => undefined
      unobserve = () => undefined
      disconnect = () => undefined
    }
  )
  Element.prototype.scrollTo ??= () => undefined
})

let mounted: { root: Root; container: HTMLElement }[] = []
afterEach(async () => {
  for (const { root, container } of mounted) {
    await act(async () => root.unmount())
    container.remove()
  }
  mounted = []
  vi.unstubAllGlobals()
})

/** The runtime the chat page builds per thread, in Act mode. */
const useThreadRuntime = () =>
  useConversationRuntime({
    mode: () => "act",
    onFinish: () => undefined,
    // On offer, as the page offers them on a new chat; a stored
    // conversation must never show one.
    suggestions: [{ prompt: "Build my website" }],
    dictation: undefined,
  })

function Chat() {
  const runtime = useRemoteThreadListRuntime({
    adapter: conversationList,
    runtimeHook: useThreadRuntime,
    threadId: ID,
  })
  return createElement(
    AssistantRuntimeProvider,
    { runtime },
    createElement(Thread, {
      autoFocus: false,
      stored: true,
      components: { ToolFallback: Approval },
    })
  )
}

/** The conversation opened on what the api holds now. */
async function open(history: unknown) {
  stored = history
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => root.render(createElement(Chat)))
  await vi.waitFor(() =>
    expect(
      container.querySelector(
        '[data-slot="ask-fact"], [data-slot="request-change"]'
      )
    ).not.toBeNull()
  )
  return container
}

/**
 * The transcript as the owner reads it: every message and card, in order.
 * A card folded into a tool group reads as folded, because the owner has to
 * go looking for it.
 */
const transcript = (container: HTMLElement) =>
  [
    ...container.querySelectorAll(
      '[data-slot="aui_user-message-root"], [data-slot="ask-fact"], [data-slot="request-change"]'
    ),
  ].map(
    (node) =>
      (node.closest('[data-slot="tool-group-root"]') ? "folded: " : "") +
      node.textContent?.replace(/\s+/g, " ").trim()
  )

const button = (container: HTMLElement, name: string) => {
  const found = [...container.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === name
  )
  if (!found) throw new Error(`no ${name} button`)
  return found
}

async function press(container: HTMLElement, name: string) {
  await act(async () => button(container, name).click())
}

async function type(container: HTMLElement, text: string) {
  const input = container.querySelector("textarea")
  if (!input) throw new Error("no composer")
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set
    set?.call(input, text)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  const send = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Send message"]'
  )
  await act(async () => send?.click())
}

/** Settles when the thread holds what a fresh load of `history` shows. */
async function matches(container: HTMLElement, history: unknown) {
  const reloaded = await open(history)
  await vi.waitFor(() =>
    expect(transcript(container)).toEqual(transcript(reloaded))
  )
  // Every card stays in the conversation, none in a collapsed tool group.
  expect(
    transcript(reloaded).filter((line) => line?.startsWith("folded:"))
  ).toEqual([])
}

it("a stored conversation loading shows a skeleton, never the welcome or a suggestion", async () => {
  const release: { open?: () => void } = {}
  hold = new Promise<void>((resolve) => {
    release.open = resolve
  })
  stored = FIXTURE.histories.start
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => root.render(createElement(Chat)))
  await vi.waitFor(() =>
    expect(
      container.querySelector('[data-slot="aui_thread-history-skeleton"]')
    ).not.toBeNull()
  )
  expect(container.textContent).not.toContain("What should we do today?")
  expect(container.textContent).not.toContain("Build my website")
  hold = null
  await act(async () => release.open?.())
  await vi.waitFor(() =>
    expect(transcript(container)).toEqual([
      "What is your business called?Business nameSave",
    ])
  )
})

it("renders a recorded answer turn the way a reload of the stored row does", async () => {
  const chat = await open(FIXTURE.histories.typed)
  // A question overtaken by a typed message, the message, and the question
  // asked again with the business name filled in.
  expect(transcript(chat)).toEqual([
    "What is your business called?Not answered. You sent a message instead.",
    "Hello",
    "What is your business called?Business nameSave",
  ])
  expect(chat.querySelector("input")?.value).toBe("Fixture Cleaning Co")

  turns.push(sse(FIXTURE.streams.name))
  await press(chat, "Save")
  await vi.waitFor(() =>
    expect(transcript(chat).at(-1)).toContain(
      "What number should customers ring?"
    )
  )
  // Only the turn went out, and it is the one the api was sent.
  expect(sent).toEqual([FIXTURE.streams.name.request])
  await matches(chat, FIXTURE.histories.name)
})

it("offers the build, keeps a not now, and a typed change after it", async () => {
  const chat = await open(FIXTURE.histories.pricing)
  // Every answer stays on screen in its place: the overtaken question, the
  // owner's message, four answers and the open price question.
  expect(transcript(chat)).toEqual([
    "What is your business called?Not answered. You sent a message instead.",
    "Hello",
    "What is your business called?Fixture Cleaning Co",
    "What number should customers ring?+447700900123",
    "Which email address should enquiries go to?hello@example.net",
    "What are your hours on weekdays?08:00 to 18:00",
    "Where do you work from, and how far do you travel?Leeds, within 15 km",
    "What do you charge an hour for a standard clean?Hourly price, in poundsSaveSkip for now",
  ])
  turns.push(sse(FIXTURE.streams.skip))
  await press(chat, "Skip for now")
  await vi.waitFor(() =>
    expect(transcript(chat).at(-1)).toContain("Build my website")
  )
  await matches(chat, FIXTURE.histories.offered)

  turns.push(sse(FIXTURE.streams.deny))
  await press(chat, "Not now")
  await vi.waitFor(() =>
    expect(transcript(chat).at(-1)).toContain("You said not now.")
  )

  turns.push(sse(FIXTURE.streams.change))
  await type(chat, "Add Saturday hours, 9 to 1.")
  await vi.waitFor(() =>
    expect(transcript(chat).at(-1)).toContain(
      "Add Saturday hours, 9 to 1.This starts a build"
    )
  )
  // The no stays a no on screen, as it does in the stored row.
  await matches(chat, FIXTURE.histories.change)
  expect(
    sent.flatMap((body) => {
      const { turn } = ChatRequest.parse(body)
      return turn.kind === "results"
        ? turn.results.map((r) => r.kind)
        : turn.kind
    })
  ).toEqual(["answer", "approval", "message"])
})

const FAILURES = {
  "a network failure": () => Promise.reject(new TypeError("Failed to fetch")),
  "a 400": refusal(
    400,
    "chat.answer_invalid",
    "That answer does not fit the question."
  ),
  "a 503": refusal(
    503,
    "request.failed",
    "The team did not answer. Try again."
  ),
  "a 409 chat.stale": refusal(
    409,
    "chat.stale",
    "This conversation has moved on. Reload it."
  ),
}

for (const [failure, answer] of Object.entries(FAILURES)) {
  it(`after ${failure}, the thread shows what is stored and the question can be answered again`, async () => {
    const chat = await open(FIXTURE.histories.start)
    const before = transcript(chat)
    turns.push(answer)
    await press(chat, "Save")
    // Back to the stored row: the question open again, the error inline.
    await vi.waitFor(() => expect(transcript(chat)).toEqual(before))
    await vi.waitFor(() =>
      expect(
        chat.querySelector(".aui-message-error-message")?.textContent
      ).toBeTruthy()
    )
    expect(chat.querySelector("form button")?.textContent).toBe("Save")

    // A typed message after the failure lands as the api stores it.
    turns.push(sse(FIXTURE.streams.typed))
    await type(chat, "Hello")
    await vi.waitFor(() => expect(transcript(chat)).toHaveLength(3))
    await matches(chat, FIXTURE.histories.typed)
  })
}
