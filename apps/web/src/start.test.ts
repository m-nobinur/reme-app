import { describe, expect, it } from "vitest"
import { csrfMiddleware } from "./start"

/**
 * The CSRF check every request passes before AuthKit reads its cookie. The
 * middleware is called directly, with a `next` that marks the request as let
 * through.
 */
type Server = (args: {
  request: Request
  handlerType: "serverFn" | "router"
  next: () => Promise<Response>
}) => Promise<Response>

const server = (csrfMiddleware as unknown as { options: { server: Server } })
  .options.server

const ORIGIN = "https://app.remeai.co.uk"

const status = async (method: string, path: string, site: string) => {
  const response = await server({
    request: new Request(`${ORIGIN}${path}`, {
      method,
      headers: { "sec-fetch-site": site },
    }),
    handlerType: "router",
    next: async () => new Response(null, { status: 200 }),
  })
  return response.status
}

describe("the CSRF check on route handlers", () => {
  it.each(["/api/chat", "/api/assets"])(
    "refuses a cross-site POST to %s and lets a same-origin one through",
    async (path) => {
      expect(await status("POST", path, "cross-site")).toBe(403)
      expect(await status("POST", path, "same-site")).toBe(403)
      expect(await status("POST", path, "same-origin")).toBe(200)
    }
  )

  it.each(["/api/auth/callback", "/api/google/callback"])(
    "lets the provider's cross-site GET back to %s through",
    async (path) => {
      expect(await status("GET", path, "cross-site")).toBe(200)
    }
  )

  it("still checks a server function called by GET", async () => {
    const response = await server({
      request: new Request(`${ORIGIN}/_serverFn/x`, {
        headers: { "sec-fetch-site": "cross-site" },
      }),
      handlerType: "serverFn",
      next: async () => new Response(null, { status: 200 }),
    })
    expect(response.status).toBe(403)
  })
})
