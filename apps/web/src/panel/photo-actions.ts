import type { PhotoActions } from "@workspace/ui/components/generated-photos"
import { askForChanges } from "@/lib/api/server"
import type { WriteOutcome } from "@/lib/api/types"

/**
 * The review's three photo actions, as change requests on the one path every
 * change takes. "Try another" is the quick lane's `photo` kind (a one-slot
 * redraw); an upload or a removal is a `section` change, which the Developer
 * makes, because it edits the site's own files. The slot id rides in the
 * words, which is how the orchestrator finds the slot.
 *
 * `send` runs one write the way the surface shows pending and errors.
 */
export function photoActions(
  send: (write: () => Promise<WriteOutcome>) => void
): PhotoActions {
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
        const form = new FormData()
        form.append("files", file)
        const response = await fetch("/api/assets", {
          method: "POST",
          body: form,
        })
        if (!response.ok) {
          return {
            done: false,
            reason: "That photo did not upload. Try another file.",
          }
        }
        return await ask(
          `Use the photo I just uploaded for "${p.alt}" (${p.slot_id}) instead of the generated one, in the ${p.section.replaceAll("_", " ")} section.`,
          "section"
        )()
      }),
  }
}
