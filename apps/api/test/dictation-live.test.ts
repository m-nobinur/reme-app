import { readFileSync } from "node:fs"
import { fileURLToPath, URL } from "node:url"
import {
  DICTATION_SAMPLE_RATE,
  type DictationEvent,
} from "@workspace/contracts"
import { expect, it } from "vitest"
import { eventOf, NOVA_3, NOVA_3_INPUT } from "../src/dictation.ts"

/**
 * The speech model, for real: a recorded clip streamed to Nova-3 on Workers AI
 * with the Worker's own parameters, and the model's frames read back through
 * the Worker's own `eventOf`. About 0.1 cent a run, so it is not part of the
 * suite: it runs when `CF_ACCOUNT_ID` and `CF_API_TOKEN` (a token with Workers
 * AI read access) are set.
 *
 * The clip is `say -v Daniel` at 170 words a minute, converted to 16 kHz mono
 * 16-bit PCM, so the words below are what it should hear.
 */
const WORDS = ["book", "clean", "friday", "morning", "remind", "quote"]
const CLIP = fileURLToPath(
  new URL("./fixtures/dictation-clip.wav", import.meta.url)
)
const live = process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN

it.skipIf(!live)(
  "hears the clip: partial phrases first, then finals that carry its words",
  { timeout: 60_000 },
  async () => {
    const pcm = readFileSync(CLIP).subarray(44)
    const query = new URLSearchParams(NOVA_3_INPUT).toString()
    const socket = new WebSocket(
      `wss://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/${NOVA_3}?${query}`,
      {
        headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}` },
      } as never
    )
    const events: DictationEvent[] = []
    const done = new Promise<void>((resolve, reject) => {
      socket.addEventListener("message", (message) => {
        const event = eventOf(message.data)
        if (event) events.push(event)
      })
      socket.addEventListener("close", () => resolve())
      socket.addEventListener("error", () => reject(new Error("socket error")))
    })
    await new Promise((resolve) =>
      socket.addEventListener("open", resolve, { once: true })
    )
    // 100 ms of audio at a time, as a browser's capture sends it.
    const chunk = (DICTATION_SAMPLE_RATE / 10) * 2
    for (let at = 0; at < pcm.length; at += chunk) {
      socket.send(pcm.subarray(at, at + chunk))
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    socket.send(JSON.stringify({ type: "CloseStream" }))
    await done

    expect(events.some((event) => event.type === "partial")).toBe(true)
    const heard = events
      .filter((event) => event.type === "final")
      .map((event) => event.text)
      .join(" ")
      .toLowerCase()
    for (const word of WORDS) expect(heard).toContain(word)
  }
)
