import type { AvatarId } from "@workspace/contracts"
import { AssistantAvatar } from "@workspace/ui/components/assistant-avatar"
import { Skeleton } from "@workspace/ui/components/skeleton"
import type { CSSProperties, FC } from "react"

/**
 * What a conversation looks like before its messages arrive. It imports
 * nothing from assistant-ui, so the route can render it on the server while
 * the chat chunk loads, and the thread can render the same thing while
 * history loads: the two hand over without a change on screen.
 */
export const ThreadHistorySkeleton: FC = () => (
  <div
    data-slot="aui_thread-history-skeleton"
    role="status"
    className="flex flex-col gap-y-6"
  >
    <span className="sr-only">Loading conversation</span>
    <Skeleton className="ml-auto h-9 w-2/5 rounded-3xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-11/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-4/5 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-3/5 motion-reduce:animate-none" />
    </div>
    <Skeleton className="ml-auto h-9 w-1/3 rounded-3xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-10/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-2/3 motion-reduce:animate-none" />
    </div>
  </div>
)

/** The thread's own variables, which size its column and composer. */
export const THREAD_STYLE = {
  "--thread-max-width": "44rem",
  "--composer-bg": "var(--color-card)",
  "--composer-radius": "var(--radius-2xl)",
  "--composer-padding": "8px",
} as CSSProperties

/** The new chat's greeting: the assistant's face, the question, the briefing. */
export const ThreadWelcomeView: FC<{
  avatar: AvatarId | null
  briefing: string | null | undefined
}> = ({ avatar, briefing }) => (
  // No entrance motion: the page loads into the task, not into a show.
  <div className="aui-thread-welcome-root mb-6 flex flex-col items-center px-4 text-center">
    <AssistantAvatar className="mb-4 size-14" id={avatar} />
    <h1 className="aui-thread-welcome-message-inner font-semibold text-[1.75rem] leading-tight tracking-tight">
      What should we do today?
    </h1>
    {briefing ? (
      <p
        data-slot="aui_thread-briefing"
        className="mt-2 max-w-prose text-base text-muted-foreground"
      >
        {briefing}
      </p>
    ) : null}
  </div>
)

/**
 * The whole thread before the chat chunk has loaded: the transcript skeleton
 * above an empty composer, in the thread's own layout and variables, so
 * nothing moves when the real one replaces it. The scroller keeps the
 * thread's scrollbar and its clearance of the workspace panel, since both
 * decide where the column sits.
 */
export const ThreadPending: FC = () => (
  <div className="flex h-full flex-col bg-background" style={THREAD_STYLE}>
    <div className="flex flex-1 flex-col overflow-y-scroll pe-(--panel-inset)">
      <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4">
        <ThreadHistorySkeleton />
        <div className="mt-auto pb-4 md:pb-6">
          <div className="h-[calc(2.25rem+2*var(--composer-padding)+2px)] w-full rounded-(--composer-radius) border border-border bg-(--composer-bg)" />
        </div>
      </div>
    </div>
  </div>
)

/**
 * A new chat before the chat chunk has loaded: the greeting it opens with
 * above the tall empty composer, centred as the thread centres them, so the
 * real one replaces it in place.
 */
export const NewChatPending: FC<{
  avatar: AvatarId | null
  briefing: string | null
  /** How many updates the stack under the composer will show. */
  updates: number
}> = ({ avatar, briefing, updates }) => (
  <div className="flex h-full flex-col bg-background" style={THREAD_STYLE}>
    <div className="flex flex-1 flex-col overflow-y-scroll pe-(--panel-inset)">
      <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col justify-center px-4 pt-4">
        <ThreadWelcomeView avatar={avatar} briefing={briefing} />
        <div className="flex flex-col gap-2 pb-4 md:pb-6">
          <div className="h-[calc(4rem+0.5rem+2.25rem+2*var(--composer-padding)+2px)] w-full rounded-(--composer-radius) border border-border bg-(--composer-bg)" />
          {updates > 0 ? (
            // The deck's room for the edges of up to two cards under the front
            // one. shortcut: the card is the site card's height, so a stack
            // led by a one-line row is 4px shorter; measure if that shows.
            <div
              style={{
                paddingBottom: `${Math.min(updates - 1, 2) * 0.375}rem`,
              }}
            >
              <Skeleton className="h-[4.125rem] rounded-2xl motion-reduce:animate-none" />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  </div>
)
