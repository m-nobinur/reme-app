import { expect, it } from "vitest"
import { readCapped } from "./body"

const CAP = 64 * 1024

/** A body sent in chunks with no declared length. */
const chunked = (sizes: number[]) =>
  new Request("https://web.test/api/chat", {
    method: "POST",
    body: new ReadableStream({
      start(controller) {
        for (const size of sizes)
          controller.enqueue(new Uint8Array(size).fill(97))
        controller.close()
      },
    }),
    // @ts-expect-error Node's fetch needs this for a stream body.
    duplex: "half",
  })

it("reads a body within the cap as text, untouched", async () => {
  const body = '{"mode":"act","turn":{"kind":"message"}}'
  expect(
    await readCapped(
      new Request("https://web.test/api/chat", { method: "POST", body }),
      CAP
    )
  ).toBe(body)
  expect(await readCapped(chunked([CAP / 2, CAP / 2]), CAP)).toHaveLength(CAP)
})

it("refuses a declared length over the cap before reading", async () => {
  const request = new Request("https://web.test/api/chat", {
    method: "POST",
    body: "{}",
    headers: { "content-length": String(CAP + 1) },
  })
  expect(await readCapped(request, CAP)).toBeNull()
})

it("refuses a chunked body once it passes the cap", async () => {
  expect(await readCapped(chunked([CAP, 1]), CAP)).toBeNull()
})
