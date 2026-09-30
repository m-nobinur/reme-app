import { UploadedAssets } from "@workspace/contracts"
import { chatFetch } from "./turn"

/**
 * The upload card's way to store photos: one multipart request to the
 * Worker's `/api/assets`, field `files`, with a key per press so a retried
 * request stores nothing twice. A refusal throws the api's own sentence.
 */
export async function uploadPhotos(
  files: File[],
  send: (url: string, init: RequestInit) => Promise<Response> = chatFetch
): Promise<UploadedAssets> {
  const form = new FormData()
  for (const file of files) form.append("files", file, file.name)
  const response = await send("/api/assets", {
    method: "POST",
    body: form,
    headers: { "idempotency-key": crypto.randomUUID() },
  })
  const stored = UploadedAssets.safeParse(
    await response.json().catch(() => null)
  )
  if (!stored.success) {
    throw new Error(
      "The photos may have been stored, but the answer could not be read. Reload before you send them again."
    )
  }
  return stored.data
}
