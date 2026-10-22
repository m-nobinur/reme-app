import { Skeleton } from "@workspace/ui/components/skeleton"
import type { FC } from "react"

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

/**
 * The whole thread before the chat chunk has loaded: the transcript skeleton
 * above an empty composer, in the thread's own layout and variables, so
 * nothing moves when the real one replaces it. The scroller keeps the
 * thread's scrollbar and its clearance of the workspace panel, since both
 * decide where the column sits.
 */
export const ThreadPending: FC = () => (
  <div
    className="flex h-full flex-col bg-background"
    style={{
      ["--thread-max-width" as string]: "44rem",
      ["--composer-bg" as string]: "var(--color-card)",
      ["--composer-radius" as string]: "var(--radius-2xl)",
      ["--composer-padding" as string]: "8px",
    }}
  >
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
