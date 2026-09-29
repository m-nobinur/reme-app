import { WorkOS as WorkerWorkOS } from "@workos-inc/node/worker"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { toFailure } from "./failure"
import { CLIENT_OPTIONS, WORKOS_TIMEOUT_MS, workos } from "./workos"

/**
 * WorkOS that accepts the connection and never answers, which is what an
 * outage looked like from here. The only way out is the abort signal.
 */
function stalledFetch() {
  return vi.fn(
    (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError"))
        )
      })
  )
}

/** Settles `attempt` against the fake clock and returns what it threw. */
async function failureAfterStall(
  attempt: Promise<unknown>
): Promise<{ early: boolean; error: unknown }> {
  let settled = false
  const caught = attempt.then(
    () => undefined,
    (error: unknown) => error
  )
  void caught.then(() => {
    settled = true
  })
  await vi.advanceTimersByTimeAsync(WORKOS_TIMEOUT_MS - 1)
  const early = settled
  await vi.advanceTimersByTimeAsync(1)
  return { early, error: await caught }
}

// Never sent anywhere: the fetch below answers nothing.
const password = {
  email: "owner@example.com",
  password: "x".repeat(12),
  clientId: "client_test",
}

describe("the WorkOS client", () => {
  let fetch: ReturnType<typeof stalledFetch>

  beforeEach(() => {
    vi.useFakeTimers()
    fetch = stalledFetch()
    vi.stubGlobal("fetch", fetch)
    vi.stubEnv("WORKOS_API_KEY", "sk_test_fake")
    vi.stubEnv("WORKOS_CLIENT_ID", "client_test")
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it("gives up on a stalled WorkOS at the timeout, once, as a retryable failure", async () => {
    const { early, error } = await failureAfterStall(
      workos().userManagement.authenticateWithPassword(password)
    )
    expect(early).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(toFailure(error)).toEqual({
      code: "timeout",
      message:
        "The sign-in service did not answer in time. Try again in a moment.",
    })
  })

  // The build workerd resolves. It ignores `timeout` and reads `config`.
  it("bounds the Worker build of the SDK the same way", async () => {
    const client = new WorkerWorkOS("sk_test_fake", {
      clientId: "client_test",
      ...CLIENT_OPTIONS,
    })
    const { early, error } = await failureAfterStall(
      client.userManagement.createPasswordReset({ email: password.email })
    )
    expect(early).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(toFailure(error).code).toBe("timeout")
  })
})
