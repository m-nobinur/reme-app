import { z } from "zod"

/**
 * Voice dictation in the owner's composer. The browser streams the microphone
 * to the api's `GET /dictate` WebSocket and the api relays it to the speech
 * model, so no provider key reaches the browser. The wire is the same
 * whichever model sits behind it; only the api knows the provider.
 *
 * The WebSocket is opened on the api's own host, where the web session's
 * cookie does not go, so `POST /dictation/ticket` (an owner's session) mints
 * a short-lived ticket the socket carries in its query instead.
 */

export const DICTATION_TICKET_PATH = "/dictation/ticket"
export const DICTATION_PATH = "/dictate"

/** What a browser sends: mono 16-bit little-endian PCM at this rate, in binary frames. */
export const DICTATION_SAMPLE_RATE = 16_000

/** How long a ticket opens a socket after it is minted. */
export const DICTATION_TICKET_SECONDS = 60

/** The longest one dictation runs before the api ends it as if the owner had stopped. */
export const DICTATION_MAX_SECONDS = 300

/** Dictations one person may start a minute (`wrangler.jsonc` declares the same). */
export const DICTATIONS_PER_MINUTE = 10

/** The ticket `POST /dictation/ticket` answers with. */
export const DictationTicket = z.strictObject({ ticket: z.string().min(1) })
export type DictationTicket = z.infer<typeof DictationTicket>

/**
 * Text frames from the api: `partial` is the words so far of the phrase being
 * spoken, each one replacing the last, and `final` is that phrase settled.
 */
export const DictationEvent = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("partial"), text: z.string() }),
  z.strictObject({ type: z.literal("final"), text: z.string() }),
  z.strictObject({ type: z.literal("error") }),
])
export type DictationEvent = z.infer<typeof DictationEvent>

/** The one text frame a browser sends: finish and settle what was said. */
export const DICTATION_STOP = JSON.stringify({ type: "stop" })
export const DictationControl = z.strictObject({ type: z.literal("stop") })
