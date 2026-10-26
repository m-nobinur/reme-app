import type { PictureActions } from "@workspace/ui/components/site-pictures"
import { trayServices } from "@/chat/tray-services"
import { uploadPhotos } from "@/chat/upload"
import { askForChanges } from "@/lib/api/server"
import type { WriteOutcome } from "@/lib/api/types"

/** The id of one uploaded file, or null when it did not upload. */
const uploaded = (file: File) =>
  uploadPhotos([file]).then(
    (stored) => stored.assets[0]?.id ?? null,
    () => null
  )

/**
 * The three ways to change a picture, as change requests on the one path every
 * change takes. "Try another" is the quick lane's `photo` kind (a one-slot
 * redraw); an upload or a removal is a `section` change, which the Developer
 * makes, because it edits the site's own files. The slot id rides in the
 * words, which is how the orchestrator finds the slot.
 *
 * `send` runs one write the way the surface shows pending and errors.
 */
export function photoActions(
  send: (write: () => Promise<WriteOutcome>) => void
): PictureActions {
  const ask = (text: string, changeKind: "photo" | "section") => () =>
    askForChanges({ data: { text, key: crypto.randomUUID(), changeKind } })
  return {
    onTryAnother: (p) =>
      send(ask(`Try another photo for "${p.alt}" (${p.slot_id}).`, "photo")),
    onRemove: (p) =>
      send(
        ask(
          `Remove the picture "${p.alt}" (${p.slot_id}) from the ${p.section.replaceAll("_", " ")} section and use the section's variant without an image.`,
          "section"
        )
      ),
    onUseOwn: (p, file) =>
      send(async () => {
        const id = await uploaded(file)
        return id
          ? await ask(
              `Use the photo I just uploaded (asset ${id}) for "${p.alt}" (${p.slot_id}) instead of the current one, in the ${p.section.replaceAll("_", " ")} section.`,
              "section"
            )()
          : {
              done: false,
              reason: "That photo did not upload. Try another file.",
            }
      }),
  }
}

/**
 * A new logo: kept as the org's logo, as the logo page keeps one, then a
 * change that puts it on the site.
 */
export const replaceLogo = (file: File) => async (): Promise<WriteOutcome> => {
  const id = await uploaded(file)
  const kept = id && (await trayServices.keepLogo(id).catch(() => null))
  if (!kept) {
    return {
      done: false,
      reason: "That logo did not upload. Try another file.",
    }
  }
  return await askForChanges({
    data: {
      text: `Use my new logo (asset ${kept.asset.id}) on the site in place of the old one.`,
      key: crypto.randomUUID(),
      changeKind: "section",
    },
  })
}
