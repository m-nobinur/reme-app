import { CHAT_TURN_MS, ErrorEnvelope } from "@workspace/contracts"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { API_TIMEOUT_MS } from "./transport"

/**
 * Item 18: a call to `apps/api` that never starts answering reaches an error
 * within `API_TIMEOUT_MS` rather than holding the page open. The stub below
 * answers only when aborted, the way a stalled provider does.
 */

vi.mock("@tanstack/react-start/server", () => ({ getCookie: () => "sealed" }))
vi.mock("@workos/authkit-tanstack-react-start", () => ({
  getAuthKitContextOrNull: () => null,
}))

let signal: AbortSignal | undefined

beforeEach(() => {
  vi.useFakeTimers()
  process.env.REME_API_URL = "https://api.test"
  signal = undefined
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** An api that never answers: the request settles only when it is aborted. */
function stall() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: URL, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          signal = init.signal ?? undefined
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          )
        })
    )
  )
}

it("answers a stalled call with a transient 504 envelope once the bound passes", async () => {
  stall()
  const { apiSource } = await import("./client")
  const answer = apiSource.chat("{}")
  // A chat turn may wait on the onboarding planner, then the script.
  expect(CHAT_TURN_MS).toBeGreaterThan(API_TIMEOUT_MS)
  await vi.advanceTimersByTimeAsync(CHAT_TURN_MS - 1)
  expect(signal?.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  const response = await answer
  expect(response?.status).toBe(504)
  expect(ErrorEnvelope.parse(await response?.json())).toMatchObject({
    class: "transient",
    code: "api.timeout",
  })
})

it("turns a stalled read into an error a screen can show, on the ordinary bound", async () => {
  stall()
  const { apiSource } = await import("./client")
  const read = apiSource.staff()
  const settled = expect(read).rejects.toThrow("504")
  await vi.advanceTimersByTimeAsync(API_TIMEOUT_MS)
  await settled
})

it("does not bound a reply once it has started, so a chat stream runs on", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: URL, init: RequestInit) => {
      signal = init.signal ?? undefined
      return new Response("data: [DONE]\n\n")
    })
  )
  const { apiSource } = await import("./client")
  await apiSource.chat("{}")
  await vi.advanceTimersByTimeAsync(API_TIMEOUT_MS * 3)
  expect(signal?.aborted).toBe(false)
})
