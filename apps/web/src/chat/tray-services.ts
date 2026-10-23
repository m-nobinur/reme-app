import {
  KeptLogo,
  LogoRound,
  LogoRounds,
  PaletteFromImage,
  ReviewedPhotos,
} from "@workspace/contracts"
import type { TrayServices } from "@workspace/ui/components/assistant/tray-services"
import type { z } from "zod"
import { chatFetch } from "./turn"
import { uploadPhotos } from "./upload"

/**
 * The design tray's logo, photos and palette pages, against the Worker's
 * same-origin routes. Each write carries a key of its own press, so a
 * retried request does nothing twice; a refusal throws the api's own
 * sentence (`chatFetch`).
 */

const write = (body?: unknown): RequestInit => ({
  method: "POST",
  headers: {
    "idempotency-key": crypto.randomUUID(),
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

async function read<T>(
  schema: z.ZodType<T>,
  url: string,
  init?: RequestInit
): Promise<T> {
  const response = await chatFetch(url, init)
  const parsed = schema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) {
    throw new Error("That did not come back as expected. Try again.")
  }
  return parsed.data
}

export const trayServices: TrayServices = {
  upload: (files) => uploadPhotos(files),
  reviewPhotos: (ids) =>
    read(ReviewedPhotos, "/api/assets/review", write({ asset_ids: ids })),
  paletteFromImage: (file) => {
    const form = new FormData()
    form.append("file", file, file.name)
    return read(PaletteFromImage, "/api/palettes/from-image", {
      method: "POST",
      body: form,
      headers: { "idempotency-key": crypto.randomUUID() },
    })
  },
  drawLogos: (request) => read(LogoRound, "/api/logos", write(request)),
  logoRounds: (toolCallId) =>
    read(
      LogoRounds,
      `/api/logos?tool_call_id=${encodeURIComponent(toolCallId)}`
    ),
  keepLogo: (id) =>
    read(KeptLogo, `/api/logos/${encodeURIComponent(id)}/keep`, write()),
  imageUrl: (id) => `/api/photos/${encodeURIComponent(id)}`,
}
