import {
  PaintBrushIcon,
  PlugsConnectedIcon,
  RocketLaunchIcon,
  SpinnerGapIcon,
} from "@phosphor-icons/react"
import { UpdateRow } from "@workspace/ui/components/assistant/update-deck"
import { Button } from "@workspace/ui/components/button"
import {
  type Preview,
  PreviewLink,
  Shot,
  SiteIcon,
  type VersionPictures,
} from "@workspace/ui/components/live-panel"
import { StatusLine } from "@workspace/ui/components/status-line"
import { publishLine } from "@workspace/ui/lib/activity-copy"
import { cn, META } from "@workspace/ui/lib/utils"
import { useEffect, useId, useLayoutEffect, useState } from "react"
import { createPortal } from "react-dom"

/**
 * How long the load check usually takes to bring the live message: its
 * minute-2 check, with time for the message to land. Past it the line says the
 * site is slow to come online.
 */
export const PUBLISH_LATE_MS = 150_000

/**
 * The end of a build, said in the conversation that is open: the site's
 * icon, name and Publish, its home page, then Request changes and Preview.
 * It is drawn from the workspace, not stored in the thread, and never
 * optimistic: Publish waits for the server, and "approved" shows only once
 * the decision is recorded. Docked, it is one item of the update stack above
 * the composer (`spot`) until the site is published: its first row, which
 * opens the whole card. In a thread it is drawn into one node that moves
 * from the chat to the stack, so docking moves the card rather than drawing
 * it again.
 * As a row, it is that row alone, for the new chat's updates.
 */
export function SiteReady({
  title,
  meta,
  pictures,
  preview,
  onRetryPreview,
  approved = false,
  published = false,
  live = false,
  pending = false,
  held = false,
  error = null,
  connect = null,
  onApprove,
  onMakeChanges,
  docked = false,
  spot,
  closeOn = null,
  row = false,
  className,
}: {
  title: string
  meta: string
  pictures: VersionPictures | null
  preview: Preview | "loading" | "error"
  onRetryPreview?: (() => Promise<void>) | undefined
  /** The owner approved it here and the server recorded it. */
  approved?: boolean
  /** That version is live; the assistant's live message is still to come. */
  published?: boolean
  /** The assistant said it is live: the approval stays as its result. */
  live?: boolean
  /** The approval is on its way to the server. */
  pending?: boolean
  /** An update to it is being made, so it waits to be published with that. */
  held?: boolean
  /** Why the last approval did not go through, in the owner's words. */
  error?: string | null
  /** A step beside Publish, such as setting up the web address; none when null. */
  connect?: { label: string; onClick: () => void } | null
  onApprove: () => void
  /** Puts the composer in website change mode. */
  onMakeChanges: () => void
  /** The owner has written since it was put up: it sits in `spot`, above the composer. */
  docked?: boolean
  /**
   * In a thread, its place in the update stack once docked (null until that
   * is drawn). Left out, the card stays where it is drawn.
   */
  spot?: HTMLElement | null
  /** A docked card the owner opened closes when this changes: each message they send. */
  closeOn?: string | null
  /** Only its first row, unframed, for a deck of updates. */
  row?: boolean
  className?: string
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  // Closed in the render that sees the new value, not by a remount.
  const [openFor, setOpenFor] = useState(closeOn)
  if (openFor !== closeOn) {
    setOpenFor(closeOn)
    setOpen(false)
  }
  const inTray = docked && !!spot
  const checking = published && !live
  const [late, setLate] = useState(false)
  useEffect(() => {
    setLate(false)
    if (!checking) return
    const timer = setTimeout(() => setLate(true), PUBLISH_LATE_MS)
    return () => clearTimeout(timer)
  }, [checking])
  // The node the card is drawn into, put in its spot in the chat or in the tray.
  // A box of no layout, so the card fills its row in the stack.
  const [host] = useState(() => {
    if (typeof document === "undefined") return null
    const node = document.createElement("div")
    node.className = "contents"
    return node
  })
  const [inline, setInline] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const into = inTray ? spot : inline
    if (host && into && host.parentElement !== into) into.appendChild(host)
  }, [host, inTray, spot, inline])
  useLayoutEffect(() => () => void host?.remove(), [host])
  const done = (
    <p
      className={cn("flex text-sm", inTray || row ? "p-3" : className)}
      data-slot="site-ready"
    >
      <StatusLine
        delay={0}
        label={publishLine(published, live, late)}
        state={live ? "done" : "working"}
      />
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
  const publish = (
    <Button
      className="relative shrink-0 overflow-visible"
      disabled={pending || held}
      onClick={onApprove}
      size="sm"
    >
      {pending ? (
        <SpinnerGapIcon aria-hidden className="animate-spin" />
      ) : (
        <RocketLaunchIcon aria-hidden />
      )}
      {pending ? "Publishing" : "Publish"}
      {/* Waiting on the owner: the bell's unread mark, so it reads as theirs to do. */}
      {pending || held ? null : (
        <span
          aria-hidden
          className="absolute -top-1 -right-1 size-2.5 rounded-full bg-destructive ring-2 ring-card"
          data-slot="attention-dot"
        />
      )}
    </Button>
  )
  const failed = error ? (
    <p className="px-3 pb-3 text-[0.8125rem] text-destructive" role="alert">
      {error}
    </p>
  ) : held ? (
    <p className="px-3 pb-3 text-[0.8125rem] text-muted-foreground">
      Publishing waits until your update is ready.
    </p>
  ) : null
  if (row) {
    return approved ? (
      done
    ) : (
      <div className="flex min-w-0 flex-1 flex-col" data-slot="site-ready-row">
        <UpdateRow
          action={publish}
          icon={<SiteIcon src={pictures?.icon} />}
          meta={meta}
          title={title}
        />
        {failed}
      </div>
    )
  }
  const shot = (
    <Shot
      alt="Your home page on a laptop"
      className="aspect-[16/10]"
      src={pictures?.laptop}
      still={
        <span aria-hidden className="font-medium text-muted-foreground text-sm">
          {title}
        </span>
      }
    />
  )
  const card = approved ? (
    done
  ) : (
    <article
      aria-labelledby={`${id}-title`}
      className={cn(
        "flex min-w-0 flex-1 flex-col overflow-hidden",
        // Docked, the stack's own card is its frame.
        !inTray && [
          "max-w-xl rounded-2xl border border-border bg-card",
          className,
        ]
      )}
      data-slot={inTray ? "site-ready-docked" : "site-ready"}
    >
      <div className="flex items-center gap-3 p-3">
        {inTray ? (
          // Docked it is one row, which opens and closes the whole card in place.
          <button
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-lg outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => setOpen(!open)}
            type="button"
          >
            {name}
          </button>
        ) : (
          name
        )}
        {connect ? (
          <Button
            className="shrink-0"
            onClick={connect.onClick}
            size="sm"
            variant="outline"
          >
            <PlugsConnectedIcon aria-hidden />
            {connect.label}
          </Button>
        ) : null}
        {publish}
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
      {failed}
    </article>
  )
  // Outside a thread, and on the server, it stays where it is drawn.
  if (spot === undefined || !host) return card
  return (
    <>
      {inTray ? null : <div ref={setInline} />}
      {createPortal(card, host)}
    </>
  )
}
