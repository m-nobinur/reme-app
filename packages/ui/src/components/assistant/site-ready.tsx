import { CheckCircleIcon } from "@phosphor-icons/react"
import { type Preview, VersionCard } from "@workspace/ui/components/live-panel"
import { cn } from "@workspace/ui/lib/utils"

/**
 * The end of a build, said in the conversation that is open: the version
 * card with its home page, a preview, Publish and Request changes. It is
 * drawn from the workspace, not stored in the thread, and never optimistic:
 * Publish waits for the server, and "approved" shows only once the decision
 * is recorded.
 */
export function SiteReady({
  title,
  meta,
  preview,
  onRetryPreview,
  approved = false,
  pending = false,
  error = null,
  onApprove,
  onMakeChanges,
  className,
}: {
  title: string
  meta: string
  preview: Preview | "loading" | "error"
  onRetryPreview?: (() => Promise<void>) | undefined
  /** The owner approved it here and the server recorded it. */
  approved?: boolean
  /** The approval is on its way to the server. */
  pending?: boolean
  /** Why the last approval did not go through, in the owner's words. */
  error?: string | null
  onApprove: () => void
  /** Puts the composer in website change mode. */
  onMakeChanges: () => void
  className?: string
}) {
  if (approved) {
    return (
      <p
        className={cn(
          "flex items-center gap-2 text-muted-foreground text-sm",
          className
        )}
        data-slot="site-ready"
      >
        <CheckCircleIcon aria-hidden className="size-4 shrink-0 text-primary" />
        Approved. Your website is being published.
      </p>
    )
  }
  return (
    <div className={cn("max-w-xl", className)} data-slot="site-ready">
      <VersionCard
        error={error}
        meta={meta}
        onPublish={onApprove}
        onRequestChanges={onMakeChanges}
        onRetryPreview={onRetryPreview}
        pending={pending ? "approve" : null}
        preview={preview}
        shot
        title={title}
      />
    </div>
  )
}
