// @vitest-environment happy-dom
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  AssistantRuntimeProvider,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react"
import { ChatRequest, TOOL_CALL_CANCELLED } from "@workspace/contracts"
import { Approval } from "@workspace/ui/components/assistant/approval"
import { CosToolsProvider } from "@workspace/ui/components/assistant/cos-tools"
import { Thread } from "@workspace/ui/components/assistant/thread"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { conversationList } from "./conversations"
import { useConversationRuntime } from "./runtime"
import { sendsOn } from "./turn"

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

// Every time the AI SDK asks whether to send on its own, and what it was
// told: the only way to see that it decided not to send.
vi.mock("./turn", async (original) => {
  const turn = await original<typeof import("./turn")>()
  return { ...turn, sendsOn: vi.fn(turn.sendsOn) }
})

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
    "start" | "typed" | "name" | "tagline" | "offered" | "denied" | "change",
    unknown
  >
  streams: Record<"typed" | "name" | "skip" | "deny" | "change", Stream>
}
const ID = FIXTURE.conversation.id

/** What the api holds now, and how it answers the next `/chat` turns. */
let stored: unknown
let turns: (() => Promise<Response>)[] = []
let sent: unknown[] = []
/** Each thumb the api was sent, and how it answers the next one. */
let rated: { body: unknown; key: string | null }[] = []
let rateStatus = 204
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
  vi.mocked(sendsOn).mockClear()
  tools = {
    zone: "Europe/London",
    question: (requestId) =>
      requestId === REQUEST_ID ? "Saturday hours" : null,
  }
  process.env.REME_API_URL = "https://api.test"
  sent = []
  turns = []
  rated = []
  rateStatus = 204
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
      if (path === `/conversations/${ID}/feedback`) {
        rated.push({
          body: JSON.parse(String(init?.body)),
          key: new Headers(init?.headers).get("idempotency-key"),
        })
        return new Response(null, { status: rateStatus })
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

/** The runtime the chat page builds per thread. */
const useThreadRuntime = () =>
  useConversationRuntime({
    onFinish: () => undefined,
    // On offer, as the page offers them on a new chat; a stored
    // conversation must never show one.
    suggestions: [{ prompt: "Build my website" }],
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
    createElement(
      CosToolsProvider,
      { value: tools },
      createElement(Thread, {
        autoFocus: false,
        stored: true,
        components: { ToolFallback: Approval },
      })
    )
  )
}

/**
 * What the chat page gives the cards: the owner's zone, and the questions
 * the workspace holds open. A test swaps either before it opens the chat.
 */
let tools = {
  zone: "Europe/London",
  question: (requestId: string): string | null =>
    requestId === REQUEST_ID ? "Saturday hours" : null,
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
        '[data-slot="ask-fact"], [data-slot="request-change"], [data-slot="create-reminder"]'
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
  ].map((node) => {
    // Without the time and tick: a message sent live shows the clock's time,
    // and the fixture rows were stored on another day.
    const copy = node.cloneNode(true) as Element
    for (const meta of copy.querySelectorAll(
      '[data-slot="aui_user-message-meta"]'
    ))
      meta.remove()
    return (
      (node.closest('[data-slot="tool-group-root"]') ? "folded: " : "") +
      copy.textContent?.replace(/\s+/g, " ").trim()
    )
  })

/** The first button by that name the owner can still press. */
const button = (container: HTMLElement, name: string) => {
  const found = [...container.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === name && !each.disabled
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

it("a stored conversation's skeleton stays up until its messages arrive, with no blank between", async () => {
  const release: { open?: () => void } = {}
  hold = new Promise<void>((resolve) => {
    release.open = resolve
  })
  stored = FIXTURE.histories.start
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  // What the owner sees after each change: the skeleton, the messages, or
  // nothing where the conversation goes.
  const seen: string[] = []
  new MutationObserver(() => {
    const now = container.querySelector(
      '[data-slot="aui_thread-history-skeleton"]'
    )
      ? "skeleton"
      : transcript(container).length
        ? "messages"
        : "blank"
    if (seen.at(-1) !== now) seen.push(now)
  }).observe(container, { childList: true, subtree: true })
  await act(async () => root.render(createElement(Chat)))
  await vi.waitFor(() => expect(seen).toContain("skeleton"))
  // Long enough for the runtime to swap its placeholder thread for the
  // stored one.
  await new Promise((resolve) => setTimeout(resolve, 100))
  hold = null
  await act(async () => release.open?.())
  await vi.waitFor(() => expect(seen.at(-1)).toBe("messages"))
  expect(seen.slice(seen.indexOf("skeleton"))).toEqual(["skeleton", "messages"])
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
  // Only the turn went out, and it is the one the api was sent, with the
  // owner's reply under the id the chat gave it.
  const request = FIXTURE.streams.name.request as {
    turn: { reply: object }
  }
  expect(sent).toEqual([
    {
      ...request,
      time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      turn: {
        ...request.turn,
        reply: { ...request.turn.reply, message_id: expect.any(String) },
      },
    },
  ])
  // The answer reads as the owner's reply, and the next question as a
  // message of its own, with its own time.
  expect(transcript(chat).slice(-2)).toEqual([
    "Fixture Cleaning Co",
    "What number should customers ring?Phone numberSave",
  ])
  expect(
    chat.querySelectorAll('[data-slot="aui_assistant-message-root"]')
  ).toHaveLength(3)
  await matches(chat, FIXTURE.histories.name)
})

it("offers the build, keeps a not now, and a typed change after it", async () => {
  const chat = await open(FIXTURE.histories.tagline)
  // Every answer stays on screen in its place, as the owner's reply: the
  // overtaken question, the owner's message, five replies and the open
  // tagline question.
  expect(transcript(chat)).toEqual([
    "What is your business called?Not answered. You sent a message instead.",
    "Hello",
    "Fixture Cleaning Co",
    "+447700900123",
    "hello@example.net",
    "08:00 to 18:00",
    "Leeds, within 15 km",
    "How would you sum up your business in one line?TaglineSaveSkip for now",
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
    // The answer goes back to the card, never into the composer.
    expect(chat.querySelector("textarea")?.value).toBe("")

    // A typed message after the failure lands as the api stores it.
    turns.push(sse(FIXTURE.streams.typed))
    await type(chat, "Hello")
    await vi.waitFor(() => expect(transcript(chat)).toHaveLength(3))
    await matches(chat, FIXTURE.histories.typed)
  })
}

/**
 * A Chief of Staff step as `apps/api` stores it: a read the agent ran
 * itself, then two calls that wait on the owner. Ids have the shapes of
 * `apps/api/test/cos-recorded-turn.json`: the provider's call ids and the
 * SDK's approval ids.
 */
const COS = "Qm3vT8xLr2WcNf5p"
const READ = "call_81a1d2d8144143768bba913d"
const CHANGE = "call_033f85dfac7e4140ba76f31a"
const QUESTION = "call_f95c13d21f6d4666876663f1"
const CHANGE_APPROVAL = "aitxt-ZWhRxAZy2eiSJtmVmPNfsgpN"
const QUESTION_APPROVAL = "aitxt-Hk4pQ9sLw2Vn7bTc1RxYe3Ud"
const REQUEST_ID = "0f4b2c8e-1a3d-4e5f-9b6c-7d8e9f0a1b2c"
const AT = "2026-09-27T10:00:00.000Z"
const row = <C extends object>(
  id: string,
  parent: string | null,
  content: C
) => ({
  id,
  parent_id: parent,
  format: "ai-sdk/v6",
  content: { ...content, metadata: { custom: { createdAt: AT } } },
  feedback: null,
})
const WORKSPACE = {
  site: { host: null, live_version: null },
  builds: [],
  questions: [],
  approvals: [],
  missing_facts: [],
}
const OWNER_ROW = row("msg_owner", null, {
  role: "user",
  parts: [{ type: "text", text: "Add Saturday hours, 9 to 1." }],
})
const STEP_ROW = row(COS, "msg_owner", {
  role: "assistant",
  parts: [
    { type: "step-start" },
    {
      type: "tool-get_workspace",
      toolCallId: READ,
      state: "output-available",
      input: {},
      output: WORKSPACE,
    },
    {
      type: "tool-request_change",
      toolCallId: CHANGE,
      state: "approval-requested",
      input: { text: "Add Saturday hours, 9 to 1." },
      approval: { id: CHANGE_APPROVAL },
    },
    {
      type: "tool-answer_question",
      toolCallId: QUESTION,
      state: "approval-requested",
      input: { request_id: REQUEST_ID, value: "Saturdays, 9 to 1" },
      approval: { id: QUESTION_APPROVAL },
    },
  ],
})
const COS_HISTORY = { messages: [OWNER_ROW, STEP_ROW] }

const frames = (...chunks: object[]) =>
  [...chunks.map((chunk) => JSON.stringify(chunk)), "[DONE]"]
    .map((data) => `data: ${data}\n\n`)
    .join("")

/** Both calls settled, as `settledLead` in `apps/api/src/chat.ts` sends them. */
const SETTLED = [
  {
    type: "tool-approval-response",
    approvalId: CHANGE_APPROVAL,
    approved: true,
  },
  {
    type: "tool-output-available",
    toolCallId: CHANGE,
    output: {
      outcome: "started",
      build: {
        assignment_id: "5b0f6c1e-8d2a-4f3b-9c4d-2e1a7b6c5d4e",
        kind: "site.revise",
        state: "queued",
        goal: "Add Saturday hours, 9 to 1.",
        revision: null,
        created_at: AT,
        updated_at: AT,
      },
    },
  },
  {
    type: "tool-approval-response",
    approvalId: QUESTION_APPROVAL,
    approved: true,
  },
  {
    type: "tool-output-available",
    toolCallId: QUESTION,
    output: { outcome: "answered", request_id: REQUEST_ID },
  },
]

/**
 * How the api answers the results turn. The model: the settled calls right
 * after `start`, then its own steps, here a reply and a last step that is a
 * read at the step limit. The fallback: a new step, then the settled calls,
 * so its last step is empty and the SDK's own checks never send again; only
 * the model's answer can show the owner-result check at work.
 */
const RESOLVED = {
  "the model": frames(
    { type: "start", messageId: COS },
    ...SETTLED,
    { type: "start-step" },
    { type: "text-start", id: "txt-0" },
    {
      type: "text-delta",
      id: "txt-0",
      delta: "Started, and I saved your answer.",
    },
    { type: "text-end", id: "txt-0" },
    { type: "finish-step" },
    { type: "start-step" },
    {
      type: "tool-input-start",
      toolCallId: "call_read_2",
      toolName: "get_workspace",
    },
    {
      type: "tool-input-available",
      toolCallId: "call_read_2",
      toolName: "get_workspace",
      input: {},
    },
    {
      type: "tool-output-available",
      toolCallId: "call_read_2",
      output: WORKSPACE,
    },
    { type: "finish-step" },
    { type: "finish", finishReason: "tool-calls" }
  ),
  "the fallback": frames(
    { type: "start", messageId: COS },
    { type: "start-step" },
    ...SETTLED,
    { type: "finish-step" },
    { type: "finish" }
  ),
}

const changeCard = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-slot="request-change"]')

/** Resolves once the SDK has asked `sendsOn` `times` times, with the answers. */
async function decided(times: number) {
  await vi.waitFor(() =>
    expect(vi.mocked(sendsOn).mock.results).toHaveLength(times)
  )
  return vi.mocked(sendsOn).mock.results.map((result) => result.value)
}

const HELD = "You said yes. Sent once you answer the other cards."

for (const [answer, response] of Object.entries(RESOLVED)) {
  it(`holds a yes until every card in the step is answered, sends one turn, and nothing more after ${answer} answers`, async () => {
    const chat = await open(COS_HISTORY)
    await press(chat, "Approve")
    expect(await decided(1)).toEqual([false])
    expect(sent).toEqual([])
    // Nothing is in flight, so nothing claims the build is starting.
    expect(changeCard(chat)?.textContent).not.toContain("Starting")
    expect(
      changeCard(chat)?.querySelector('[role="status"]')?.textContent
    ).toBe(HELD)
    expect(changeCard(chat)?.querySelector('[aria-busy="true"]')).toBeNull()

    turns.push(sse({ request: null, response }))
    await press(chat, "Send answer")
    await vi.waitFor(() =>
      expect(changeCard(chat)?.textContent).toContain("Started.")
    )
    expect(sent.map((body) => ChatRequest.parse(body).turn)).toEqual([
      {
        kind: "results",
        message_id: COS,
        results: [
          { kind: "approval", approval_id: CHANGE_APPROVAL, approved: true },
          { kind: "approval", approval_id: QUESTION_APPROVAL, approved: true },
        ],
      },
    ])
    // Once the stream ends the SDK asks again. Every call now has its
    // output, none of it the owner's, so it sends nothing more, even when
    // the last step is a read the agent ran itself.
    expect(await decided(3)).toEqual([false, true, false])
    expect(sent).toHaveLength(1)
    expect(chat.querySelector(".aui-message-error-message")).toBeNull()
  })
}

it("the question card holds its yes the same way", async () => {
  const chat = await open(COS_HISTORY)
  await press(chat, "Send answer")
  expect(await decided(1)).toEqual([false])
  expect(
    chat.querySelector('[data-slot="answer-question"] [role="status"]')
      ?.textContent
  ).toBe(HELD)
})

it("a held not now says so on either card", async () => {
  const NOT_NOW = "You said not now. Sent once you answer the other cards."
  const first = await open(COS_HISTORY)
  await press(first, "Not now")
  expect(await decided(1)).toEqual([false])
  expect(changeCard(first)?.querySelector('[role="status"]')?.textContent).toBe(
    NOT_NOW
  )

  const second = await open(COS_HISTORY)
  const question = second.querySelector<HTMLElement>(
    '[data-slot="answer-question"]'
  )
  if (!question) throw new Error("no question card")
  await act(async () => button(question, "Not now").click())
  expect(await decided(2)).toEqual([false, false])
  expect(question.querySelector('[role="status"]')?.textContent).toBe(NOT_NOW)
})

it("a message typed while a yes is held cancels it, as the api stores it", async () => {
  const chat = await open(COS_HISTORY)
  await press(chat, "Approve")
  await vi.waitFor(() => expect(changeCard(chat)?.textContent).toContain(HELD))
  turns.push(
    sse({
      request: null,
      response: frames(
        { type: "start", messageId: "Rt7wYk2Pq9LmXc4v" },
        { type: "start-step" },
        { type: "text-start", id: "txt-0" },
        { type: "text-delta", id: "txt-0", delta: "Noted: 10 to 2." },
        { type: "text-end", id: "txt-0" },
        { type: "finish-step" },
        { type: "finish" }
      ),
    })
  )
  await type(chat, "Make it 10 to 2.")
  await vi.waitFor(() => expect(chat.textContent).toContain("Noted: 10 to 2."))
  expect(chat.textContent).not.toContain(HELD)
  const cancelled = { state: "output-error", errorText: TOOL_CALL_CANCELLED }
  await matches(chat, {
    messages: [
      OWNER_ROW,
      {
        ...STEP_ROW,
        content: {
          ...STEP_ROW.content,
          parts: STEP_ROW.content.parts.map(({ approval: _, ...part }) =>
            part.type === "tool-request_change" ||
            part.type === "tool-answer_question"
              ? { ...part, ...cancelled }
              : part
          ),
        },
      },
      row("msg_typed", COS, {
        role: "user",
        parts: [{ type: "text", text: "Make it 10 to 2." }],
      }),
      row("Rt7wYk2Pq9LmXc4v", "msg_typed", {
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "text", text: "Noted: 10 to 2." },
        ],
      }),
    ],
  })
})

it("a yes already sent, with no other card waiting, says it is starting", async () => {
  // A load while the turn runs: the stored row has the yes and no result.
  const chat = await open({
    messages: [
      OWNER_ROW,
      {
        ...STEP_ROW,
        content: {
          ...STEP_ROW.content,
          parts: [
            { type: "step-start" },
            {
              type: "tool-request_change",
              toolCallId: CHANGE,
              state: "approval-responded",
              input: { text: "Add Saturday hours, 9 to 1." },
              approval: { id: CHANGE_APPROVAL, approved: true },
            },
          ],
        },
      },
    ],
  })
  const card = changeCard(chat)
  expect(card?.textContent).toContain("Starting")
  expect(card?.textContent).not.toContain(HELD)
  expect(card?.querySelector('[aria-busy="true"]')).not.toBeNull()
})

/** The api's own copy for `chat.busy`, in `apps/api/src/chat.ts`. */
const BUSY = "I'm still working on your last message. Try again in a moment."

const ACTIONS = {
  "a typed message": (chat: HTMLElement) => type(chat, "Make it 10 to 2."),
  "a whole step of yeses": async (chat: HTMLElement) => {
    await press(chat, "Approve")
    await press(chat, "Send answer")
  },
}

for (const [action, run] of Object.entries(ACTIONS)) {
  it(`${action} sent while another tab's turn runs shows chat.busy and is not sent again`, async () => {
    const chat = await open(COS_HISTORY)
    turns.push(refusal(409, "chat.busy", BUSY))
    await run(chat)
    await vi.waitFor(() =>
      expect(chat.querySelector('[role="alert"]')?.textContent).toContain(BUSY)
    )
    // The alert shows only once the one request has failed for good.
    expect(sent).toHaveLength(1)
    // Back to what is stored: both cards open, a typed message in the
    // composer to send again once the other turn ends.
    await vi.waitFor(() =>
      expect(
        [...chat.querySelectorAll("button")]
          .filter((each) => !each.disabled)
          .map((each) => each.textContent?.trim())
          .filter((name) => name === "Approve" || name === "Send answer")
      ).toEqual(["Approve", "Send answer"])
    )
    if (action === "a typed message") {
      expect(chat.querySelector("textarea")?.value).toBe("Make it 10 to 2.")
    }
  })
}

it("shows every Chief of Staff tool in the owner's words, and nothing of its wire shape", async () => {
  const part = (tool: string, id: string, fields: object) => ({
    type: `tool-${tool}`,
    toolCallId: `call_${id}`,
    ...fields,
  })
  const chat = await open({
    messages: [
      OWNER_ROW,
      row(COS, "msg_owner", {
        role: "assistant",
        parts: [
          { type: "step-start" },
          part("get_workspace", "read", {
            state: "output-available",
            input: {},
            output: WORKSPACE,
          }),
          part("get_facts", "facts", {
            state: "output-available",
            input: {},
            output: {
              facts: [
                {
                  key: "business.name",
                  value: { name: "Fixture Cleaning Co" },
                },
              ],
            },
          }),
          part("get_preview", "preview", {
            state: "output-available",
            input: { assignment_id: REQUEST_ID },
            output: {
              outcome: "refused",
              error: {
                class: "resource",
                code: "assignment.not_found",
                message: "No assignment with that id in this business.",
              },
            },
          }),
          part("request_change", "change", {
            state: "output-error",
            input: { text: "Add Saturday hours, 9 to 1." },
            approval: { id: CHANGE_APPROVAL, approved: true },
            errorText:
              "unknown_outcome (orchestrator.timeout): the tool did not report back, so nothing is known about its result.",
          }),
          part("request_change", "capped", {
            state: "output-available",
            input: { text: "Swap the hero photo." },
            approval: { id: "aitxt-Cap4pQ9sLw2Vn7bTc1RxYe3U", approved: true },
            output: {
              outcome: "refused",
              error: {
                class: "resource",
                code: "builds.daily_cap",
                message: "A business starts at most 20 builds in 24 hours.",
              },
            },
          }),
          part("answer_question", "question", {
            state: "output-available",
            input: {
              request_id: REQUEST_ID,
              value: {
                key: "hours.weekday",
                value: { open: "08:00", close: "18:00" },
              },
            },
            approval: { id: QUESTION_APPROVAL, approved: true },
            output: { outcome: "answered", request_id: REQUEST_ID },
          }),
          part("create_reminder", "reminder", {
            state: "approval-requested",
            input: { title: "Call the window supplier", due_at: null },
            approval: { id: "aitxt-Rm4pQ9sLw2Vn7bTc1RxYe3Ud" },
          }),
        ],
      }),
    ],
  })
  await press(chat, "Checked 3 things")
  await press(chat, "Checked for a preview")
  const shown = chat.textContent ?? ""
  for (const text of [
    "Checked your workspace",
    "Read your business details",
    "Checked for a preview",
    "That build is not in your workspace.",
    "You have started as many builds as a day allows. Try again tomorrow.",
    "We could not confirm this went through.",
    "Weekday hours: 08:00 to 18:00",
    "Sent. Your build carries on.",
    "Call the window supplier",
    "No date set. It shows under Reminders.",
  ]) {
    expect(shown, text).toContain(text)
  }
  for (const wire of [
    "No assignment with that id",
    "A business starts at most",
    "get_",
    "request_change",
    "create_reminder",
    "call_",
    REQUEST_ID,
    "unknown_outcome",
    "{",
  ]) {
    expect(shown, wire).not.toContain(wire)
  }
  expect(button(chat, "Add reminder")).toBeDefined()
})

const reminderRow = (input: object, fields: object) =>
  row(COS, "msg_owner", {
    role: "assistant",
    parts: [
      { type: "step-start" },
      {
        type: "tool-create_reminder",
        toolCallId: "call_reminder",
        input: { title: "Call the window supplier", ...input },
        ...fields,
      },
    ],
  })

for (const [zone, written, kept, label] of [
  [
    "Australia/Sydney",
    "2026-10-02T08:00:00+10:00",
    "2026-10-01T22:00:00.000Z",
    "Sydney time",
  ],
  [
    "America/New_York",
    "2026-10-02T08:00:00-04:00",
    "2026-10-02T12:00:00.000Z",
    "New York time",
  ],
] as const) {
  it(`a reminder shows the time the owner approves and gets, in ${label}`, async () => {
    tools = { ...tools, zone }
    const asking = await open({
      messages: [
        OWNER_ROW,
        reminderRow(
          // The model's offset is a guess the api ignores: the digits are
          // read as the owner's wall time.
          { due_at: written.replace(/[+-]\d\d:\d\d$/, "+01:00") },
          { state: "approval-requested", approval: { id: "aitxt-rem" } }
        ),
      ],
    })
    expect(asking.textContent).toContain(`Due 2 Oct 2026, 08:00 ${label}`)

    const added = await open({
      messages: [
        OWNER_ROW,
        reminderRow(
          { due_at: written },
          {
            state: "output-available",
            approval: { id: "aitxt-rem", approved: true },
            output: { outcome: "created", due_at: kept },
          }
        ),
      ],
    })
    expect(added.textContent).toContain(
      `Added to Reminders. Due 2 Oct 2026, 08:00 ${label}.`
    )
  })
}

it("an answer names the question it goes to, and offers no yes for one no longer open", async () => {
  const named = await open(COS_HISTORY)
  const card = named.querySelector('[data-slot="answer-question"]')
  expect(card?.textContent).toContain(
    "This answers your build's question: Saturday hours."
  )

  tools = { ...tools, question: () => null }
  const unknown = await open(COS_HISTORY)
  const orphan = unknown.querySelector<HTMLElement>(
    '[data-slot="answer-question"]'
  )
  expect(orphan?.textContent).toContain("no longer open")
  expect(
    [...(orphan?.querySelectorAll("button") ?? [])].map((b) => b.textContent)
  ).toEqual(["Not now"])
})

it("a change it cannot read offers no yes, only a way to let the step go on", async () => {
  const chat = await open({
    messages: [
      OWNER_ROW,
      row(COS, "msg_owner", {
        role: "assistant",
        parts: [
          { type: "step-start" },
          {
            type: "tool-request_change",
            toolCallId: CHANGE,
            state: "approval-requested",
            input: { text: "" },
            approval: { id: CHANGE_APPROVAL },
          },
        ],
      }),
    ],
  })
  const card = changeCard(chat)
  expect(card?.textContent).toContain("did not come through")
  expect(
    [...(card?.querySelectorAll("button") ?? [])].map((b) => b.textContent)
  ).toEqual(["Not now"])
})

it("a call the stream left unfinished stops, rather than working forever", async () => {
  const chat = await open(COS_HISTORY)
  turns.push(
    sse({
      request: null,
      response: frames(
        { type: "start", messageId: "Ws3kLm8Qp2Rt5vXy" },
        { type: "start-step" },
        {
          type: "tool-input-start",
          toolCallId: "call_read_3",
          toolName: "get_workspace",
        },
        {
          type: "tool-input-available",
          toolCallId: "call_read_3",
          toolName: "get_workspace",
          input: {},
        },
        {
          type: "tool-input-start",
          toolCallId: "call_rem_2",
          toolName: "create_reminder",
        },
        {
          type: "tool-input-delta",
          toolCallId: "call_rem_2",
          inputTextDelta: '{"title":"Call',
        },
        { type: "finish-step" },
        { type: "finish" }
      ),
    })
  )
  await type(chat, "Remind me to call the supplier.")
  await vi.waitFor(() =>
    expect(chat.textContent).toContain("This was not finished.")
  )
  expect(chat.textContent).toContain("Stopped checking your workspace")
  expect(chat.querySelector(".shimmer")).toBeNull()
  // The turn is over: the composer offers Send again, not Stop.
  expect(chat.querySelector('button[aria-label="Send message"]')).not.toBeNull()
})

it("renders every piece of model or owner text on a card as text, never as markup", async () => {
  const INJECTED = "![x](https://evil.example/t.png) https://evil.example/go"
  const part = (tool: string, id: string, fields: object) => ({
    type: `tool-${tool}`,
    toolCallId: `call_${id}`,
    ...fields,
  })
  const chat = await open({
    messages: [
      OWNER_ROW,
      row(COS, "msg_owner", {
        role: "assistant",
        parts: [
          { type: "step-start" },
          part("get_workspace", "read", {
            state: "output-available",
            input: {},
            output: {
              ...WORKSPACE,
              builds: [
                {
                  assignment_id: "5b0f6c1e-8d2a-4f3b-9c4d-2e1a7b6c5d4e",
                  kind: "site.revise",
                  state: "implementing",
                  goal: INJECTED,
                  version: null,
                },
              ],
            },
          }),
          part("get_facts", "facts", {
            state: "output-available",
            input: {},
            output: {
              facts: [{ key: "business.name", value: { name: INJECTED } }],
            },
          }),
          part("request_change", "change", {
            state: "approval-requested",
            input: { text: INJECTED },
            approval: { id: CHANGE_APPROVAL },
          }),
          part("answer_question", "question", {
            state: "approval-requested",
            input: { request_id: REQUEST_ID, value: INJECTED },
            approval: { id: QUESTION_APPROVAL },
          }),
          part("create_reminder", "reminder", {
            state: "approval-requested",
            input: { title: INJECTED, due_at: null },
            approval: { id: "aitxt-Rm4pQ9sLw2Vn7bTc1RxYe3Ud" },
          }),
        ],
      }),
    ],
  })
  await press(chat, "Checked 2 things")
  await press(chat, "Checked your workspace")
  await press(chat, "Read your business details")
  // Five places the text lands: the build goal, the fact, the change, the
  // answer and the reminder, each as the characters it is.
  expect(chat.textContent?.split(INJECTED)).toHaveLength(6)
  expect(chat.querySelector("img")).toBeNull()
  expect(chat.querySelector('a[href*="evil.example"]')).toBeNull()
})

/** A conversation whose last reply is text, rated `feedback`, after a card. */
const ratedHistory = (feedback: "up" | "down" | null) => ({
  messages: [
    OWNER_ROW,
    {
      ...row(COS, "msg_owner", {
        role: "assistant",
        parts: [
          { type: "step-start" },
          {
            type: "tool-request_change",
            toolCallId: CHANGE,
            state: "output-denied",
            input: { text: "Add Saturday hours, 9 to 1." },
            approval: { id: CHANGE_APPROVAL, approved: false },
          },
        ],
      }),
    },
    row("msg_again", COS, {
      role: "user",
      parts: [{ type: "text", text: "What is live now?" }],
    }),
    {
      ...row("Tx7wYk2Pq9LmXc4v", "msg_again", {
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "text", text: "Version 3 is live." },
        ],
      }),
      feedback,
    },
  ],
})

const thumb = (container: HTMLElement, name: "Helpful" | "Not helpful") =>
  [...container.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === name
  )

it("rates a text reply with a thumb, one key per press, and reads it back", async () => {
  const chat = await open(ratedHistory("up"))
  // The stored rating shows as pressed.
  expect(thumb(chat, "Helpful")?.getAttribute("aria-pressed")).toBe("true")
  expect(thumb(chat, "Not helpful")?.getAttribute("aria-pressed")).toBe("false")
  await act(async () => thumb(chat, "Not helpful")?.click())
  await vi.waitFor(() => expect(rated).toHaveLength(1))
  expect(thumb(chat, "Not helpful")?.getAttribute("aria-pressed")).toBe("true")
  await act(async () => thumb(chat, "Helpful")?.click())
  await vi.waitFor(() => expect(rated).toHaveLength(2))
  expect(rated.map(({ body }) => body)).toEqual([
    { message_id: "Tx7wYk2Pq9LmXc4v", rating: "down" },
    { message_id: "Tx7wYk2Pq9LmXc4v", rating: "up" },
  ])
  // Each press is its own request: up, down, up never replays the first up.
  const [first, second] = rated
  expect(first?.key).toBeTruthy()
  expect(second?.key).not.toBe(first?.key)
})

it("a rating the api fails to record fails quietly", async () => {
  rateStatus = 503
  const chat = await open(ratedHistory(null))
  await act(async () => thumb(chat, "Helpful")?.click())
  await vi.waitFor(() => expect(rated).toHaveLength(1))
  expect(chat.querySelector('[role="alert"]')).toBeNull()
  expect(chat.querySelector(".aui-message-error-message")).toBeNull()
})

it("a reply that is only a card offers no thumb", async () => {
  // Even as the last message, where its action bar would show.
  const [owner, card] = ratedHistory(null).messages
  const chat = await open({ messages: [owner, card] })
  expect(changeCard(chat)).not.toBeNull()
  expect(thumb(chat, "Helpful")).toBeUndefined()
  expect(thumb(chat, "Not helpful")).toBeUndefined()
})
