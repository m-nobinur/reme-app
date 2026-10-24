import {
  CheckCircleIcon,
  PaintBrushIcon,
  RocketLaunchIcon,
  SpinnerGapIcon,
} from "@phosphor-icons/react"
import { Button } from "@workspace/ui/components/button"
import {
  type Preview,
  PreviewLink,
  Shot,
  SiteIcon,
  type VersionPictures,
} from "@workspace/ui/components/live-panel"
import { cn, META } from "@workspace/ui/lib/utils"
import { useId } from "react"

/**
 * The end of a build, said in the conversation that is open: the site's
 * icon, name and Publish, its home page, then Request changes and Preview.
 * It is drawn from the workspace, not stored in the thread, and never
 * optimistic: Publish waits for the server, and "approved" shows only once
 * the decision is recorded.
 */
export function SiteReady({
  title,
  meta,
  pictures,
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
  pictures: VersionPictures | null
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
  const id = useId()
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
  const shot = (
    <Shot
      alt="Your home page on a laptop"
      className="aspect-[16/10]"
      src={pictures?.laptop}
    />
  )
  return (
    <article
      aria-labelledby={`${id}-title`}
      className={cn(
        "flex max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-card",
        className
      )}
      data-slot="site-ready"
    >
      <div className="flex items-center gap-3 p-3">
        <SiteIcon src={pictures?.icon} />
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="font-medium text-sm" id={`${id}-title`}>
            {title}
          </h3>
          <p className={META}>{meta}</p>
        </div>
        <Button
          className="relative shrink-0 overflow-visible"
          disabled={pending}
          onClick={onApprove}
          size="sm"
        >
          {pending ? (
            <SpinnerGapIcon aria-hidden className="animate-spin" />
          ) : (
            <RocketLaunchIcon aria-hidden />
          )}
          {pending ? "Publishing" : "Publish"}
          {/* Waiting on the owner, like an unread mark. */}
          {pending ? null : (
            <span
              aria-hidden
              className="absolute -top-1 -right-1 size-2.5 rounded-full bg-foreground ring-2 ring-card"
            />
          )}
        </Button>
      </div>
      {typeof preview === "object" ? (
        // The same preview as the link below, so a screen reader hears it once.
        <a
          className="block border-border border-y"
          href={preview.url}
          rel="noopener noreferrer"
          tabIndex={-1}
          target="_blank"
        >
          {shot}
        </a>
      ) : (
        <div className="border-border border-y">{shot}</div>
      )}
      <div className="flex items-center justify-between gap-2 p-2">
        <Button onClick={onMakeChanges} size="sm" variant="ghost">
          <PaintBrushIcon aria-hidden />
          Request changes
        </Button>
        <PreviewLink onRetry={onRetryPreview} preview={preview} />
      </div>
      {error ? (
        <p className="px-3 pb-3 text-[0.8125rem] text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  )
}
