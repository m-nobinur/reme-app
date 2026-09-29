import { ErrorEnvelope } from "@workspace/contracts"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import worker from "../src/index.ts"
import { cookieHeader, env, stubJwksFetch } from "./sealed-session.ts"

/**
 * What the worker's catch-all logs for an error it answers 503: the code a
 * wrapped database error carries on its cause, or else the error's class.
 * The org resolver is the first thing an owner route reaches, so it stands
 * in for any failure below the route. With nothing to throw it resolves, and
 * the failure is the unreachable database behind it.
 */

const ORG = "00000000-0000-4000-8000-00000000ca11"
const thrown = vi.hoisted(() => ({ error: undefined as unknown }))

vi.mock("@workspace/db", async (original) => ({
  ...(await original<typeof import("@workspace/db")>()),
  resolveOrg: async () => {
    if (thrown.error) throw thrown.error
    return ORG
  },
}))

const call = async () =>
  worker.fetch(
    new Request("http://api.invalid/workspace", {
      headers: await cookieHeader({
        sub: "user_probe_catch_all",
        org_id: "org_probe_catch_all",
        role: "owner",
      }),
    }),
    {
      ...env("postgresql://127.0.0.1:1/none"),
      ORCHESTRATOR: { fetch: () => Promise.reject(new Error("unused")) },
    } as unknown as Env,
    { waitUntil: () => undefined } as unknown as ExecutionContext
  )

describe("the catch-all", () => {
  let realFetch: typeof fetch
  beforeAll(() => {
    realFetch = globalThis.fetch
    globalThis.fetch = stubJwksFetch()
  })
  afterAll(() => {
    globalThis.fetch = realFetch
  })

  it.each([
    // drizzle's wrapper: the statement limit's code is on the cause.
    [
      "a wrapped statement timeout",
      Object.assign(new Error("Failed query"), { cause: { code: "57014" } }),
      "57014",
    ],
    [
      "an error with no code",
      new TypeError("x is not a function"),
      "TypeError",
    ],
  ])("logs %s by what it was", async (_name, error, code) => {
    thrown.error = error
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined)
    try {
      const response = await call()
      expect(response.status).toBe(503)
      expect(ErrorEnvelope.parse(await response.json()).class).toBe("transient")
      expect(logged).toHaveBeenCalledWith(
        JSON.stringify({ at: "/workspace", code })
      )
    } finally {
      logged.mockRestore()
    }
  })

  it("names the org once the session has resolved to one", async () => {
    thrown.error = undefined
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined)
    try {
      expect((await call()).status).toBe(503)
      const lines = logged.mock.calls.map(([line]) => JSON.parse(String(line)))
      expect(lines).toContainEqual(
        expect.objectContaining({ at: "/workspace", org_id: ORG })
      )
    } finally {
      logged.mockRestore()
    }
  })
})
