import type { AskUploadInput } from "@workspace/contracts"

/**
 * Which of the photos an owner dropped the upload card keeps, checked
 * against the call's own limits so nothing the api would refuse is sent.
 * Each refusal is a sentence naming the file. Reads only `name`, `type`
 * and `size`, so a test passes plain objects.
 */

type Picked = { name: string; type: string; size: number }

const TYPE_NAMES: Record<string, string> = {
  "image/jpeg": "JPEG",
  "image/png": "PNG",
  "image/webp": "WebP",
}

/** "JPEG, PNG or WebP", from the call's list. */
export function typesText(accept: readonly string[]): string {
  const names = accept.map((type) => TYPE_NAMES[type] ?? type)
  return names.length > 1
    ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`
    : (names[0] ?? "")
}

/** Bytes as the owner reads them: whole megabytes, or kilobytes under one. */
export function sizeText(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return mb >= 1
    ? `${Math.floor(mb * 10) / 10} MB`
    : `${Math.ceil(bytes / 1024)} KB`
}

export function checkPhotos<F extends Picked>(
  kept: readonly F[],
  added: readonly F[],
  limits: Pick<AskUploadInput, "accept" | "max_bytes" | "max_files">
): { kept: F[]; refused: string[] } {
  const next = [...kept]
  const refused: string[] = []
  for (const file of added) {
    if (!(limits.accept as readonly string[]).includes(file.type)) {
      refused.push(`${file.name} is not a ${typesText(limits.accept)} photo.`)
    } else if (file.size > limits.max_bytes) {
      refused.push(
        `${file.name} is over ${sizeText(limits.max_bytes)}. Send a smaller copy.`
      )
    } else if (next.length >= limits.max_files) {
      refused.push(
        `${file.name} was left out: ${limits.max_files} photos is the most at once.`
      )
    } else {
      next.push(file)
    }
  }
  return { kept: next, refused }
}
