import { downloadMedia, type Graph, mediaUrl } from "./graph.ts"

const NOVA_3 = "@cf/deepgram/nova-3"
const WHISPER = "@cf/openai/whisper-large-v3-turbo"

/** WhatsApp allows 16 MB; a voice note this long is not a message to the assistant. */
const MAX_AUDIO_BYTES = 10 * 1024 * 1024

type Speech = {
  results?: { channels?: { alternatives?: { transcript?: string }[] }[] }
}

/**
 * The words in a voice note, or null when it cannot be had: media expired,
 * too long, silent, or both speech models failed. Nova-3 first; Whisper only
 * when Nova-3 throws or hears nothing, so an unsupported container still works.
 */
export async function transcribe(
  env: Pick<Env, "AI">,
  graph: Graph,
  mediaId: string
): Promise<string | null> {
  try {
    const media = await mediaUrl(graph, mediaId)
    if ((media.file_size ?? 0) > MAX_AUDIO_BYTES) return null
    const bytes = await downloadMedia(graph, media.url)
    if (bytes.byteLength > MAX_AUDIO_BYTES) return null
    const audio = {
      body: new Response(bytes).body as ReadableStream,
      contentType: media.mime_type.split(";")[0] ?? "audio/ogg",
    }
    const nova = await env.AI.run(NOVA_3, { audio } as never)
      .then(
        (out) =>
          (out as Speech).results?.channels?.[0]?.alternatives?.[0]?.transcript
      )
      .catch(() => undefined)
    if (nova?.trim()) return nova.trim()
    const whisper = (await env.AI.run(WHISPER, {
      audio: {
        body: new Response(bytes).body as ReadableStream,
        contentType: audio.contentType,
      },
    } as never)) as { text?: string }
    return whisper.text?.trim() || null
  } catch (error) {
    console.warn(
      JSON.stringify({
        code: "whatsapp.transcribe_failed",
        error: error instanceof Error ? error.message : "unknown",
      })
    )
    return null
  }
}
