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

/**
 * The tidy pass on stop: the dictated words go to `POST /dictation/tidy` and
 * come back without fillers or false starts, or as `null` to say the live
 * text stays (nothing to tidy, a pass that failed or ran past
 * `DICTATION_TIDY_MS`). The browser and the api both ask `needsTidy` first, so
 * a message that cannot gain from it costs no model call.
 */
export const DICTATION_TIDY_PATH = "/dictation/tidy"

/** The longest a tidy pass may take, end to end, before the live text stays. */
export const DICTATION_TIDY_MS = 1_500

/** The most dictated text one pass takes: far above five minutes of speech. */
export const DICTATION_TIDY_MAX_CHARS = 8_000

export const DictationTidyRequest = z.strictObject({
  text: z.string().min(1).max(DICTATION_TIDY_MAX_CHARS),
})
export type DictationTidyRequest = z.infer<typeof DictationTidyRequest>

export const DictationTidyResult = z.strictObject({
  text: z.string().min(1).nullable(),
})
export type DictationTidyResult = z.infer<typeof DictationTidyResult>

/** Up to this many words, a message with nothing below in it is left as heard. */
const SHORT_WORDS = 12

const SAID_TWICE = /\b(\w+)[\s,]+\1\b/i
const FILLER =
  /\b(?:um+|uh+|er+m?|hmm+|you know|sort of|kind of|i mean)\b|\blike,|,\s*like\b/i
const CORRECTION =
  /\b(?:no,? wait|wait,? no|actually|scratch that|make that|or rather|sorry|hang on|i meant)\b/i

/** Whether dictated words are worth a tidy pass: long, or holding a filler, a correction or a stutter. */
export function needsTidy(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean).length
  return (
    words > SHORT_WORDS ||
    FILLER.test(text) ||
    CORRECTION.test(text) ||
    SAID_TWICE.test(text)
  )
}
