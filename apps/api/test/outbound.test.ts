import { ErrorEnvelope } from "@workspace/contracts"
import { afterEach, describe, expect, it, vi } from "vitest"
import worker from "../src/index.ts"
import { bounded, WORKOS_TIMEOUT_MS, WorkosTimeout } from "../src/session.ts"
import { cookieHeader, env } from "./sealed-session.ts"

/**
 * How long this worker waits on WorkOS. The management calls are bounded
 * here; the session's JWKS fetch is bounded by `jose`, which the SDK builds
 * it with, at 5 s, and the second case holds that rather than assuming it.
 * The live route cases are in `account.test.ts`.
 */

const realFetch = globalThis.fetch
afterEach(() => {
  vi.useRealTimers()
  globalThis.fetch = realFetch
})

describe("a bounded WorkOS call", () => {
  it("passes an answer through", async () => {
    await expect(bounded(Promise.resolve("answered"))).resolves.toBe("answered")
  })

  it("fails with WorkosTimeout at the bound, not before", async () => {
    vi.useFakeTimers()
    const stalled = bounded(new Promise(() => undefined))
    const settled = vi.fn()
    stalled.catch(settled)
    await vi.advanceTimersByTimeAsync(WORKOS_TIMEOUT_MS - 1)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(stalled).rejects.toBeInstanceOf(WorkosTimeout)
  })
})

describe("a JWKS that never answers", () => {
  it("answers 503 at jose's 5 s rather than hanging", async () => {
    const headers = await cookieHeader({
      sub: "user_probe_jwks_stall",
      org_id: "org_probe_jwks_stall",
    })
    vi.useFakeTimers()
    // jose bounds the fetch with `AbortSignal.timeout`, which fake timers do not reach.
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) => {
        const controller = new AbortController()
        setTimeout(
          () =>
            controller.abort(
              new DOMException("signal timed out", "TimeoutError")
            ),
          ms
        )
        return controller.signal
      })
    let fetched!: () => void
    const asked = new Promise<void>((resolve) => {
      fetched = resolve
    })
    // Stalls the way an unreachable host does: nothing until the abort.
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      fetched()
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason)
        )
      })
    }) as typeof fetch
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined)
    try {
      let answered = false
      const answer = worker
        .fetch(
          new Request("http://api.invalid/workspace", { headers }),
          env("postgresql://127.0.0.1:1/none"),
          { waitUntil: () => undefined } as unknown as ExecutionContext
        )
        .finally(() => {
          answered = true
        })
      await asked
      await vi.advanceTimersByTimeAsync(4_999)
      expect(answered).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const response = await answer
      expect(response.status).toBe(503)
      expect(ErrorEnvelope.parse(await response.json()).class).toBe("transient")
    } finally {
      logged.mockRestore()
      timeout.mockRestore()
    }
  })
})
