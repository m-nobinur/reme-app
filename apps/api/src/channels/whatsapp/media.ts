import {
  type Asset,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_FILES,
} from "@workspace/contracts"
import type { Tenancy } from "@workspace/db"
import {
  cleanName,
  editUploads,
  sniff,
  stableId,
  uploadKey,
} from "../../assets.ts"
import type { Owner } from "../../changes.ts"
import { downloadMedia, type Graph, mediaUrl } from "./graph.ts"

const NOVA_3 = "@cf/deepgram/nova-3"
const WHISPER = "@cf/openai/whisper-large-v3-turbo"

export const PHOTO_REFUSED = `I couldn't keep that photo. It needs to be a JPEG, PNG or WebP under ${UPLOAD_MAX_BYTES / 1024 / 1024} MB, and I can hold ${UPLOAD_MAX_FILES} photos in all.`

/**
 * A photo the owner sent, kept as a web upload is: type read from its bytes,
 * stored under the org's upload key and listed in `media.uploads`. The id comes
 * from the message, so a retried turn stores the same photo once. Null when it
 * cannot be kept: expired, too big, not JPEG, PNG or WebP, or the list is full.
 */
export async function savePhoto(
  env: Pick<Env, "SITES">,
  kit: Tenancy,
  owner: Owner,
  graph: Graph,
  mediaId: string,
  messageId: string
): Promise<Asset | null> {
  try {
    const media = await mediaUrl(graph, mediaId)
    if ((media.file_size ?? 0) > UPLOAD_MAX_BYTES) return null
    const bytes = await downloadMedia(graph, media.url)
    const kind = sniff(new Uint8Array(bytes.slice(0, 12)))
    if (!kind || bytes.byteLength > UPLOAD_MAX_BYTES) return null
    const asset: Asset = {
      id: await stableId(`${owner.orgId}:whatsapp:${messageId}`),
      name: cleanName(`whatsapp-${messageId.slice(-6)}`, kind),
      content_type: kind,
      bytes: bytes.byteLength,
    }
    await env.SITES.put(uploadKey(owner.orgId, asset.id), bytes, {
      httpMetadata: { contentType: kind },
    })
    const stored = await editUploads(kit, owner, (items) => [
      ...items.filter((a) => a.id !== asset.id),
      asset,
    ])
    if (stored) return asset
    await env.SITES.delete(uploadKey(owner.orgId, asset.id))
    return null
  } catch (error) {
    console.warn(
      JSON.stringify({
        code: "whatsapp.photo_failed",
        error: error instanceof Error ? error.message : "unknown",
      })
    )
    return null
  }
}

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
