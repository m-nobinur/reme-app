import { PALETTES } from "@workspace/contracts"
import { waitText } from "@workspace/ui/components/assistant/tray-logo"
import { afterEach, expect, it, vi } from "vitest"
import { trayServices } from "./tray-services"

const ID = "0b6c1e5d-8d2a-4f3b-9c4d-2e1a7b6c5d4e"

afterEach(() => {
  vi.unstubAllGlobals()
})

it("sends the photos to review with a key, and reads the review", async () => {
  const seen: { url: string; init: RequestInit | undefined }[] = []
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    seen.push({ url, init })
    return Response.json({ photos: [], missing: [{ need: "hero", count: 1 }] })
  })
  const review = await trayServices.reviewPhotos([ID])
  expect(review.missing).toEqual([{ need: "hero", count: 1 }])
  expect(seen[0]?.url).toBe("/api/assets/review")
  expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ asset_ids: [ID] })
  expect(new Headers(seen[0]?.init?.headers).get("idempotency-key")).toMatch(
    /^[0-9a-f-]{36}$/
  )
})

it("throws the api's own sentence when it refuses", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json(
      {
        class: "resource",
        code: "logo.limit",
        message: "That is all the logos for today. Try again tomorrow.",
        occurred_at: "2026-10-23T09:00:00Z",
        detail: {},
      },
      { status: 429 }
    )
  )
  await expect(trayServices.keepLogo(ID)).rejects.toThrow(
    "That is all the logos for today. Try again tomorrow."
  )
})

it("hands an early round's wait to the page with the api's sentence", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json(
      {
        class: "resource",
        code: "logo.wait",
        message: "Your next designs can start in 5 minutes.",
        occurred_at: "2026-10-23T09:00:00Z",
        detail: {},
      },
      { status: 429, headers: { "retry-after": "300" } }
    )
  )
  const refused = await trayServices
    .drawLogos({
      tool_call_id: "call_1",
      brief: {
        description: "",
        colors: [PALETTES[0]?.swatches[2] ?? ""],
        type: "emblem",
        style: "surprise",
      },
    })
    .catch((failure: unknown) => failure)
  expect(refused).toBeInstanceOf(Error)
  expect(refused).toMatchObject({
    message: "Your next designs can start in 5 minutes.",
    retryAfter: 300,
  })
})

it("says a wait as Redesign shows it", () => {
  expect(waitText(59)).toBe("in 0:59")
  expect(waitText(299)).toBe("in 4:59")
  expect(waitText(3600)).toBe("in 1 hour")
  expect(waitText(3601)).toBe("in 2 hours")
  expect(waitText(86_400)).toBe("tomorrow")
})

it("never hands a page an answer it could not read", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ rounds: "no" }))
  await expect(trayServices.logoRounds("call_1")).rejects.toThrow(
    "That did not come back as expected. Try again."
  )
})

const [paper = "", tint = "", primary = "", ink = ""] =
  PALETTES[4]?.swatches ?? []
const line = (name: string) =>
  `${JSON.stringify({ name, stops: { paper, tint, primary, ink } })}\n`

/** A body that sends each piece when asked, so a test holds the stream open between them. */
function pieces() {
  const encoder = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c
    },
  })
  return {
    response: new Response(body, {
      headers: { "content-type": "application/x-ndjson" },
    }),
    send: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
    fail: () => controller.error(new Error("dropped")),
  }
}

it("gives the logo's palettes as each line arrives, whole lines only", async () => {
  const stream = pieces()
  vi.stubGlobal("fetch", async () => stream.response)
  const seen: string[][] = []
  const done = trayServices.logoPalettes(ID, (so_far) =>
    seen.push(so_far.map((each) => each.name))
  )
  const first = line("Harbour blue")
  stream.send(first.slice(0, 30))
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(seen).toEqual([])
  stream.send(first.slice(30) + line("Warm clay").slice(0, 10))
  await vi.waitFor(() => expect(seen).toEqual([["Harbour blue"]]))
  stream.send(line("Warm clay").slice(10))
  stream.end()
  const { palettes } = await done
  expect(seen).toEqual([["Harbour blue"], ["Harbour blue", "Warm clay"]])
  expect(palettes.map((each) => each.name)).toEqual([
    "Harbour blue",
    "Warm clay",
  ])
})

it("keeps the palettes that arrived when the stream breaks after the first", async () => {
  const stream = pieces()
  vi.stubGlobal("fetch", async () => stream.response)
  const done = trayServices.logoPalettes(ID, () => undefined)
  stream.send(line("Harbour blue"))
  await new Promise((resolve) => setTimeout(resolve, 10))
  stream.fail()
  expect((await done).palettes.map((each) => each.name)).toEqual([
    "Harbour blue",
  ])
})

it("throws when no palette arrives, and with the api's sentence when it refuses", async () => {
  vi.stubGlobal("fetch", async () => new Response(""))
  await expect(trayServices.logoPalettes(ID, () => undefined)).rejects.toThrow(
    "That did not come back as expected. Try again."
  )
  vi.stubGlobal("fetch", async () =>
    Response.json(
      {
        class: "validation",
        code: "palette.unreadable",
        message:
          "I couldn't find clear colours in that picture. Try another one.",
        occurred_at: "2026-10-23T09:00:00Z",
        detail: {},
      },
      { status: 422 }
    )
  )
  await expect(trayServices.logoPalettes(ID, () => undefined)).rejects.toThrow(
    "Try another one"
  )
})
