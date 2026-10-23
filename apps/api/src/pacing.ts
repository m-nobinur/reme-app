import type { UIMessageChunk } from "ai"

/** Where the api waits for pacing. Tests replace `sleep` with one that returns at once. */
export const clock = {
  sleep: (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms)),
}

/** What a turn's pacing reads: the owner's typed characters and when the turn began (epoch ms). */
export type Pace = { typed: number; since: number }

const READ_MS = [600, 1200] as const
/** A typed message this long gets the longest reading beat. */
const READ_FULL_CHARS = 160
const MS_PER_CHAR = [4, 6] as const
/** A message adds at most this much, however long it is. */
const TEXT_MAX_MS = 2500
const CARD_MS = [300, 500] as const

const between = ([low, high]: readonly [number, number]) =>
  low + Math.random() * (high - low)

/** The pause before the first word: longer for a longer message, less what the turn already spent. */
export const readingBeat = (typed: number, spent: number): number => {
  const [low, high] = READ_MS
  const scaled = low + (high - low) * Math.min(1, typed / READ_FULL_CHARS)
  return Math.max(0, scaled - spent)
}

/** The text in pieces of a word or two, which join back to exactly the text. */
export function wordsOf(text: string): string[] {
  const words = text.match(/\S+\s*|\s+/g) ?? []
  return Array.from({ length: Math.ceil(words.length / 2) }, (_, i) =>
    words.slice(2 * i, 2 * i + 2).join("")
  )
}

/**
 * Writes scripted chunks as a model would stream them: a reading beat
 * before the first word, the words a word or two at a time, and a short beat
 * before a card that follows text. Every chunk is passed on in order and
 * the text is unchanged. `said` means words already streamed before these
 * chunks, so there is no reading beat and the first card gets its beat.
 */
export async function pace(
  chunks: UIMessageChunk[],
  emit: (chunk: UIMessageChunk) => void,
  { typed, since }: Pace,
  said = false
): Promise<void> {
  const chars = chunks.reduce(
    (n, c) => (c.type === "text-delta" ? n + c.delta.length : n),
    0
  )
  const squeeze = Math.min(1, TEXT_MAX_MS / (chars * MS_PER_CHAR[1] || 1))
  let read = said
  let afterText = said
  for (const chunk of chunks) {
    if (chunk.type === "text-start" && !read) {
      read = true
      await clock.sleep(readingBeat(typed, Date.now() - since))
    }
    if (chunk.type === "text-delta") {
      for (const delta of wordsOf(chunk.delta)) {
        await clock.sleep(delta.length * between(MS_PER_CHAR) * squeeze)
        emit({ ...chunk, delta })
      }
      afterText = true
      continue
    }
    if (chunk.type === "tool-input-available" && afterText) {
      afterText = false
      await clock.sleep(between(CARD_MS))
    }
    emit(chunk)
  }
}
