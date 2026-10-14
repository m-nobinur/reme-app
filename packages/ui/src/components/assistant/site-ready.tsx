import {
  CheckCircleIcon,
  PaintBrushIcon,
  SpinnerGapIcon,
} from "@phosphor-icons/react"
import { Button } from "@workspace/ui/components/button"
import {
  type GeneratedPhoto,
  GeneratedPhotos,
  type PhotoActions,
} from "@workspace/ui/components/generated-photos"
import { CARD_SURFACE } from "@workspace/ui/lib/card"
import { cn } from "@workspace/ui/lib/utils"
import { useId } from "react"

/**
 * The end of a build, said in the conversation that is open: the version is
 * ready, approve it or ask for changes. It reads like the assistant's own
 * message and is drawn from the workspace, not stored in the thread. It is
 * never optimistic: Approve waits for the server, and "approved" shows only
 * once the decision is recorded.
 */
export function SiteReady({
  version,
  approved = false,
  pending = false,
  error = null,
  onApprove,
  onMakeChanges,
  onSeePreview,
  photos = [],
  photoActions,
}: {
  version: number
  /** The owner approved it here and the server recorded it. */
  approved?: boolean
  /** The approval is on its way to the server. */
  pending?: boolean
  /** Why the last approval did not go through, in the owner's words. */
  error?: string | null
  onApprove: () => void
  onMakeChanges: () => void
  /** Opens the panel on the review, with its preview and screenshots. */
  onSeePreview: () => void
  /** The pictures the assistant made, badged with the three ways to change one. */
  photos?: readonly GeneratedPhoto[]
  photoActions?: PhotoActions | undefined
}) {
  const id = useId()
  if (approved) {
    return (
      <p
        className="flex items-center gap-2 px-2 text-muted-foreground text-sm"
        data-slot="site-ready"
      >
        <CheckCircleIcon aria-hidden className="size-4 shrink-0 text-primary" />
        Approved. Version {version} is being published.
      </p>
    )
  }
  return (
    <section
      aria-labelledby={`${id}-title`}
      className={cn(CARD_SURFACE, "mx-2 flex max-w-2xl flex-col gap-3")}
      data-slot="site-ready"
    >
      <div className="flex flex-col gap-1">
        <h2 className="font-medium" id={`${id}-title`}>
          Your website is ready.
        </h2>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Version {version} is built. Approve it to publish, or tell me what to
          change and I will make a new version.{" "}
          <Button
            className="h-auto p-0 align-baseline"
            onClick={onSeePreview}
            type="button"
            variant="link"
          >
            See the preview
          </Button>
        </p>
      </div>
      {photoActions ? (
        <GeneratedPhotos
          actions={photoActions}
          disabled={pending}
          photos={photos}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={pending} onClick={onApprove} size="sm" type="button">
          {pending ? (
            <SpinnerGapIcon aria-hidden className="animate-spin" />
          ) : (
            <CheckCircleIcon aria-hidden />
          )}
          {pending ? "Approving" : "Approve"}
        </Button>
        <Button
          disabled={pending}
          onClick={onMakeChanges}
          size="sm"
          type="button"
          variant="outline"
        >
          <PaintBrushIcon aria-hidden />
          Make changes
        </Button>
      </div>
      {error ? (
        <p className="text-[0.8125rem] text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}
