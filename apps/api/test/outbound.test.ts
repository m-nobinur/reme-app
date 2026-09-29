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
  it("answers 503 within jose's 5 s rather than hanging", async () => {
    // Stalls the way an unreachable host does: nothing until the abort.
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason)
        )
      })) as typeof fetch
    const headers = await cookieHeader({
      sub: "user_probe_jwks_stall",
      org_id: "org_probe_jwks_stall",
    })
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined)
    const started = performance.now()
    try {
      const response = await worker.fetch(
        new Request("http://api.invalid/workspace", { headers }),
        env("postgresql://127.0.0.1:1/none"),
        { waitUntil: () => undefined } as unknown as ExecutionContext
      )
      const took = performance.now() - started
      expect(response.status).toBe(503)
      expect(ErrorEnvelope.parse(await response.json()).class).toBe("transient")
      expect(took).toBeGreaterThanOrEqual(4_900)
      expect(took).toBeLessThan(6_000)
    } finally {
      logged.mockRestore()
    }
  }, 10_000)
})
