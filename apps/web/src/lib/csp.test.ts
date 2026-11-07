import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { contentSecurityPolicy, cspMiddleware } from "./csp"

/**
 * The header on what the Worker answers. The middleware is called directly,
 * with a `next` standing in for the rest of the chain: it records the context
 * the router would read and answers with the response under test.
 */
type Result = { response: Response; context: { nonce?: string } }
type Server = (args: {
  next: (options: { context: { nonce: string } }) => Promise<Result>
}) => Promise<Result>

const server = (cspMiddleware as unknown as { options: { server: Server } })
  .options.server

async function answer(response: Response) {
  let handed: string | undefined
  const result = await server({
    next: async ({ context }) => {
      handed = context.nonce
      return { response, context }
    },
  })
  return {
    handed,
    header: result.response.headers.get("content-security-policy"),
  }
}

const html = () =>
  new Response("<!doctype html>", {
    headers: { "content-type": "text/html; charset=utf-8" },
  })

describe("the content security policy header", () => {
  // The api address is the Worker's own variable; another test file may have set it.
  beforeEach(() => void vi.stubEnv("REME_API_URL", ""))
  afterEach(() => void vi.unstubAllEnvs())

  it("is set on an HTML response, with the nonce the router was handed", async () => {
    const { handed, header } = await answer(html())
    expect(handed).toMatch(/^[A-Za-z0-9+/]{22}==$/)
    expect(header).toBe(contentSecurityPolicy(handed as string))
    expect(header?.split("; ")).toEqual([
      "default-src 'self'",
      `script-src 'self' 'nonce-${handed}' https://js.stripe.com https://*.js.stripe.com https://checkout.stripe.com https://connect.facebook.net`,
      "style-src 'self' 'unsafe-inline'",
      expect.stringContaining(
        "img-src 'self' data: blob: https://*.remeai.co.uk"
      ),
      "font-src 'self' data:",
      "connect-src 'self' https://api.stripe.com https://checkout.stripe.com https://*.facebook.com",
      "frame-src https://js.stripe.com https://*.js.stripe.com https://checkout.stripe.com https://hooks.stripe.com https://*.facebook.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ])
  })

  it("allows the local preview host's images under vite dev, and only there", () => {
    const img = (dev: boolean) =>
      contentSecurityPolicy("n", dev).match(/img-src [^;]*/)?.[0]
    expect(img(true)).toContain("http://*.reme.localhost:*")
    expect(img(false)).not.toContain("localhost")
  })

  it("lets the browser open the api's dictation socket, and no other address of the api's", () => {
    const connect = (api: string | undefined) =>
      contentSecurityPolicy("n", false, api).match(/connect-src [^;]*/)?.[0]
    expect(connect("https://staging-api.remeai.co.uk")).toBe(
      "connect-src 'self' https://api.stripe.com https://checkout.stripe.com https://*.facebook.com wss://staging-api.remeai.co.uk"
    )
    expect(connect("http://localhost:8787")).toContain(" ws://localhost:8787")
    expect(connect(undefined)).not.toMatch(/wss?:/)
  })

  it("never lets inline script run without the nonce", async () => {
    const { header } = await answer(html())
    expect(header?.match(/script-src [^;]*/)?.[0]).not.toContain(
      "unsafe-inline"
    )
  })

  it("is a fresh nonce on every request", async () => {
    const first = await answer(html())
    const second = await answer(html())
    expect(first.handed).not.toBe(second.handed)
  })

  it("is left off a response that is not HTML", async () => {
    const { header } = await answer(Response.json({ ok: true }))
    expect(header).toBeNull()
  })
})
