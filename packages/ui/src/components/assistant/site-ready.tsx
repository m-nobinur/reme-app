import {
  CheckCircleIcon,
  PaintBrushIcon,
  RocketLaunchIcon,
  SpinnerGapIcon,
} from "@phosphor-icons/react"
import { useTraySlot } from "@workspace/ui/components/assistant/question-tray"
import { Button } from "@workspace/ui/components/button"
import {
  type Preview,
  PreviewLink,
  Shot,
  SiteIcon,
  type VersionPictures,
} from "@workspace/ui/components/live-panel"
import { cn, META } from "@workspace/ui/lib/utils"
import { useId, useState } from "react"
import { createPortal } from "react-dom"

/**
 * The end of a build, said in the conversation that is open: the site's
 * icon, name and Publish, its home page, then Request changes and Preview.
 * It is drawn from the workspace, not stored in the thread, and never
 * optimistic: Publish waits for the server, and "approved" shows only once
 * the decision is recorded. Docked, it is held above the composer until the
 * site is published, as its first row, which opens the whole card.
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
  docked = false,
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
  /** The owner has written since it was put up: it sits above the composer. */
  docked?: boolean
  className?: string
}) {
  const id = useId()
  const slot = useTraySlot()
  const [open, setOpen] = useState(false)
  const inTray = docked && slot !== null
  const done = (
    <p
      className={cn(
        "flex items-center gap-2 text-muted-foreground text-sm",
        inTray ? "p-3" : className
      )}
      data-slot="site-ready"
    >
      <CheckCircleIcon aria-hidden className="size-4 shrink-0 text-primary" />
      Approved. Your website is being published.
    </p>
  )
  // A heading cannot sit inside the docked row's button.
  const Title = inTray ? "span" : "h3"
  const name = (
    <>
      <SiteIcon src={pictures?.icon} />
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <Title className="font-medium text-sm" id={`${id}-title`}>
          {title}
        </Title>
        <span className={META}>{meta}</span>
      </span>
    </>
  )
  const shot = (
    <Shot
      alt="Your home page on a laptop"
      className="aspect-[16/10]"
      src={pictures?.laptop}
    />
  )
  const card = approved ? (
    done
  ) : (
    <article
      aria-labelledby={`${id}-title`}
      className={cn(
        "flex flex-col overflow-hidden rounded-2xl border border-border bg-card",
        inTray
          ? "motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 duration-250 ease-out motion-safe:animate-in"
          : ["max-w-xl", className]
      )}
      data-slot={inTray ? "site-ready-docked" : "site-ready"}
    >
      <div className="flex items-center gap-3 p-3">
        {inTray ? (
          // Docked it is one row, which opens and closes the whole card in place.
          <button
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-primary"
            onClick={() => setOpen(!open)}
            type="button"
          >
            {name}
          </button>
        ) : (
          name
        )}
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
      {inTray && !open ? null : (
        <>
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
        </>
      )}
      {error ? (
        <p className="px-3 pb-3 text-[0.8125rem] text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  )
  if (!inTray) return card
  return createPortal(
    approved ? (
      <div className="rounded-2xl border border-border bg-card">{done}</div>
    ) : (
      card
    ),
    slot
  )
}
