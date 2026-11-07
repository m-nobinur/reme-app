import {
  ThreadPrimitive,
  useAui,
  useAuiState,
  useThreadViewportStore,
} from "@assistant-ui/react"
import { ArrowDownIcon } from "@phosphor-icons/react"
import { TooltipIconButton } from "@workspace/ui/components/assistant/tooltip-icon-button"
import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import { type FC, useEffect, useRef } from "react"

/**
 * Keeps the turn the viewport pins at the top when the reply's id changes as
 * the run ends. While it waits the runtime shows a placeholder reply, and a
 * reply that arrives in one piece replaces it in the same update that ends
 * the run. assistant-ui (still in 0.15.32) then drops the turn as stale and
 * takes away the space it held below the reply, so the view scrolled back up
 * over the previous reply. The turn moves to the reply that replaced the
 * placeholder.
 */
export const KeepTurnAnchor: FC = () => {
  const viewport = useThreadViewportStore()
  const aui = useAui()
  useEffect(
    () =>
      viewport.subscribe((state, previous) => {
        const turn = previous.topAnchorTurn
        if (state.topAnchorTurn || !turn) return
        const messages = aui.thread().getState().messages
        const reply = messages.at(-1)
        if (
          messages.at(-2)?.id === turn.anchorId &&
          reply?.role === "assistant" &&
          reply.id !== turn.targetId
        ) {
          state.setTopAnchorTurn({
            anchorId: turn.anchorId,
            targetId: reply.id,
          })
        }
      }),
    [viewport, aui]
  )
  return null
}

/**
 * Keeps the owner's message at the top with the reply below it until their
 * next send, and the end of the thread in view. assistant-ui follows the
 * bottom by itself only when the viewport is not anchored to a turn.
 *
 * - The spacer under the transcript holds the space below a pinned reply,
 *   sized the moment anything under the owner's message resizes. The footer sits in the scroll content, so a tray leaving, or the
 *   viewport growing, left the content short and the browser clamped the
 *   scroll before assistant-ui measured again a frame later: the owner's
 *   message dropped by the tray's height, and the drop stayed.
 * - A footer that appears or grows (the tray) under a reply that already
 *   fills the view covers its last lines: a reader at its end stays there,
 *   and one still at the start of the reply stays there too.
 * - The after slot sits in the message group ahead of that space, so a card
 *   landing in it fills the space rather than landing below it.
 * - Between turns, what lands with no turn of the owner's (a message the
 *   assistant posted on its own, or a card in the slot) is followed: a reader
 *   at the bottom glides to it, and one who scrolled up is told instead.
 * - A reply that starts while the owner scrolled up to read moves nothing:
 *   they are told, as above.
 */
export const FollowBottom: FC<{
  footer: HTMLElement | null
  after: HTMLElement | null
  spacer: HTMLElement | null
  onUnseen: (unseen: boolean) => void
  onBelow: (below: boolean) => void
}> = ({ footer, after, spacer, onUnseen, onBelow }) => {
  const store = useThreadViewportStore()
  const aui = useAui()
  const follow = useRef<() => void>(() => undefined)
  const replied = useRef<() => void>(() => undefined)
  // The reply's first words in a turn: before them it is only a placeholder.
  const replying = useAuiState((s) => {
    const last = s.thread.messages.at(-1)
    return (
      s.thread.isRunning &&
      last?.role === "assistant" &&
      last.parts.some((part) => part.type !== "text" || part.text !== "")
    )
  })
  useEffect(() => {
    if (replying) replied.current()
  }, [replying])
  // A message added to the open thread: never the history loading in, nor
  // another thread opening.
  const count = useAuiState((s) => s.thread.messages.length)
  const thread = useAuiState((s) => s.threadListItem.id)
  const seen = useRef({ count, thread })
  useEffect(() => {
    const before = seen.current
    seen.current = { count, thread }
    if (before.thread === thread && before.count > 0 && count > before.count) {
      follow.current()
    }
  }, [count, thread])
  useEffect(() => {
    const viewport = footer?.closest<HTMLElement>(
      '[data-slot="aui_thread-viewport"]'
    )
    if (!footer || !after || !spacer || !viewport) return
    const idle = () => !aui.thread().getState().isRunning
    // The end of the scroll content, the footer in it. assistant-ui's
    // `isViewportAtBottom` takes the footer's height as slack since 0.15.31,
    // which suits a footer laid over the messages, not ours.
    const atBottom = () =>
      viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 1
    const glide = (): ScrollBehavior =>
      matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth"
    // Read before a resize moves anything: scroll events come after it.
    let pinned = atBottom()
    let last = { top: viewport.scrollTop, height: viewport.scrollHeight }
    // Only the reader scrolling up lets go of the bottom. A scroll event that
    // lands while the tray is still growing (its height eases) reads short of
    // the bottom, and taking that as "not pinned" stopped the follow there,
    // 12 px up with nothing below.
    // Whether the end of the transcript is out of sight under the composer.
    // The space held below a pinned reply is room to scroll with nothing in
    // it, and Scroll to bottom over blank space took the reader nowhere.
    const below = () =>
      onBelow(
        after.getBoundingClientRect().bottom >
          footer.getBoundingClientRect().top + 1
      )
    // Where the view was before the content shrank and the browser clamped
    // the scroll, when that clamp's scroll event comes before the resize.
    let rest: number | null = null
    const onScroll = () => {
      const { scrollTop: top, scrollHeight: height } = viewport
      rest = pinned && top < last.top && height < last.height ? last.top : null
      if (top < last.top && height === last.height) pinned = false
      else if (atBottom()) pinned = true
      last = { top, height }
      if (pinned) onUnseen(false)
      below()
    }
    replied.current = () => {
      if (!pinned) onUnseen(true)
    }
    // A frame on, once the space below the reply is measured again.
    follow.current = () => {
      if (!idle()) return
      requestAnimationFrame(() => {
        if (atBottom()) return
        if (!pinned) return onUnseen(true)
        // Past the fold the held space is spent, so ending the turn moves nothing.
        if (
          after.getBoundingClientRect().bottom >
          footer.getBoundingClientRect().top
        ) {
          store.getState().setTopAnchorTurn(null)
        }
        requestAnimationFrame(() =>
          viewport.scrollTo({ top: viewport.scrollHeight, behavior: glide() })
        )
      })
    }
    // The scroll that pins the owner's message at the top, from its clamp
    // config: a tall message keeps only its last lines in view. The viewport
    // is `relative`, so the message's offset is from the top of its content,
    // read without the scroll, which a shrunk content may have clamped.
    const anchorTop = () => {
      const { element, targetConfig: clamp } = store.getState()
      const { anchor } = element
      if (anchor?.offsetParent !== viewport || !clamp) return null
      return anchor.offsetHeight > clamp.tallerThan
        ? anchor.offsetTop + anchor.offsetHeight - clamp.visibleHeight
        : anchor.offsetTop
    }
    // Sized before the frame paints, so the content never comes up short of
    // that scroll. It holds all the space the turn needs: assistant-ui's own
    // space, read here only, follows the reply alone, so a card in the slot
    // left it too tall. Seeing the spacer, assistant-ui sizes its own to
    // nothing a frame later. Gives the space that was held before.
    const hold = () => {
      const reserve =
        viewport.querySelector<HTMLElement>("[data-aui-top-anchor-reserve]")
          ?.offsetHeight ?? 0
      const held = spacer.offsetHeight + reserve
      const top = anchorTop()
      const space =
        top === null
          ? 0
          : top + viewport.clientHeight - (viewport.scrollHeight - held)
      spacer.style.height = `${Math.max(0, space)}px`
      return held
    }
    // A key typed in the composer, which sits in the scroll content, makes
    // the browser keep the caret in view, and that stops the glide to the
    // owner's message where it is. It goes on from there, a frame on: the
    // caret is kept in view after this frame's callbacks.
    const resume = () =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const top = anchorTop()
          if (pinned && top !== null && viewport.scrollTop < top - 1) {
            viewport.scrollTo({ top, behavior: glide() })
          }
        })
      )
    let height = footer.offsetHeight
    let slot = after.offsetHeight
    let size = `${viewport.clientWidth}x${viewport.clientHeight}`
    const observer = new ResizeObserver(() => {
      const held = hold()
      const shrank = footer.offsetHeight < height
      const grew = footer.offsetHeight > height
      const growth = footer.offsetHeight - height
      height = footer.offsetHeight
      const next = `${viewport.clientWidth}x${viewport.clientHeight}`
      const resized = next !== size
      size = next
      const landed = after.offsetHeight > slot
      slot = after.offsetHeight
      if (landed) follow.current()
      // Puts back what the clamp took, then goes on to the bottom: with the
      // space held, where the owner's message sits at the top. A send that
      // takes the tray or Skip this one away with it glides there as a typed
      // one does; going straight to the bottom left assistant-ui no glide.
      const back = rest ?? last.top
      if ((shrank || resized) && pinned && viewport.scrollTop < back) {
        viewport.scrollTo({ top: back, behavior: "instant" })
        viewport.scrollTo({ top: viewport.scrollHeight, behavior: glide() })
      }
      // A tray growing over that space leaves the message where it is; one
      // docking under a reply that already filled the view keeps the reader
      // at its end.
      // Only a reader already at the end: one still at a long reply's first
      // line stays there, the tray over its last lines.
      const wasAtEnd =
        viewport.scrollHeight -
          growth -
          viewport.clientHeight -
          viewport.scrollTop <=
        1
      if (grew && !held && pinned && wasAtEnd) {
        viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" })
      }
      // A scroll to where it already was fires no event.
      onScroll()
    })
    observer.observe(footer)
    observer.observe(viewport)
    observer.observe(after)
    // Each row, for the transcript outgrowing the space held below the reply.
    // Not their group: the held space sits in it, and sizing that above
    // resized an observed box inside its own callback, which the browser
    // logs as a ResizeObserver loop.
    const watch = (nodes: Iterable<Node>) => {
      for (const node of nodes) {
        if (
          node instanceof HTMLElement &&
          node !== after &&
          !node.hasAttribute("data-aui-top-anchor-reserve")
        ) {
          observer.observe(node)
        }
      }
    }
    const rows = new MutationObserver((records) => {
      for (const { addedNodes, removedNodes } of records) {
        watch(addedNodes)
        for (const node of removedNodes) {
          if (node instanceof Element) observer.unobserve(node)
        }
      }
    })
    if (after.parentElement) {
      watch(after.parentElement.children)
      rows.observe(after.parentElement, { childList: true })
    }
    viewport.addEventListener("scroll", onScroll, { passive: true })
    footer.addEventListener("input", resume)
    below()
    return () => {
      rows.disconnect()
      observer.disconnect()
      viewport.removeEventListener("scroll", onScroll)
      footer.removeEventListener("input", resume)
      follow.current = () => undefined
      replied.current = () => undefined
    }
  }, [footer, after, spacer, store, aui, onUnseen, onBelow])
  return null
}

// It shows only after a short delay: on each send the viewport leaves the
// bottom for the moment it takes to glide the sent message up, and without
// the delay the button blinked on every send. Something that landed while the
// owner read further up makes it a "New message" pill. Nothing below the
// composer but held space hides it too. It sits at the end, clear of the
// text a card puts at its start (a picker row's name and price).
export const ThreadScrollToBottom: FC<{ unseen: boolean; below: boolean }> = ({
  unseen,
  below,
}) => {
  const className = cn(
    "aui-thread-scroll-to-bottom absolute -top-12 z-10 self-end rounded-full transition-[opacity,visibility] delay-500 disabled:invisible disabled:opacity-0 disabled:delay-0 motion-reduce:transition-none",
    !below && "invisible opacity-0 delay-0"
  )
  return (
    <ThreadPrimitive.ScrollToBottom
      behavior="smooth"
      render={
        unseen ? (
          <Button className={className} size="sm" variant="outline" />
        ) : (
          <TooltipIconButton
            className={className}
            size="icon"
            tooltip="Scroll to bottom"
            variant="outline"
          />
        )
      }
    >
      <ArrowDownIcon aria-hidden />
      {unseen ? "New message" : null}
    </ThreadPrimitive.ScrollToBottom>
  )
}
