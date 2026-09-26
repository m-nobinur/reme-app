import { describe, expect, it } from "vitest"
import { BODY_MAX, boundedBody } from "../src/http.ts"

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request("http://api.invalid/x", {
    method: "POST",
    body,
    headers,
    duplex: "half",
  } as RequestInit)

describe("a request body is read no further than the cap", () => {
  it("returns a body at the cap whole", async () => {
    const body = await boundedBody(post("a".repeat(BODY_MAX)))
    expect(body?.byteLength).toBe(BODY_MAX)
  })

  it("refuses a declared length over the cap without reading it", async () => {
    const request = post("small", { "content-length": String(BODY_MAX + 1) })
    expect(await boundedBody(request)).toBeNull()
    expect(request.bodyUsed).toBe(false)
  })

  it("refuses a streamed body that declared no length once it passes the cap", async () => {
    const stream = new Blob(["a".repeat(BODY_MAX + 1)]).stream()
    expect(await boundedBody(post(stream))).toBeNull()
  })
})
