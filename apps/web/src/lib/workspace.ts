import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { Workspace, WorkspacePoll } from "./api/types"

/**
 * The panel polls `/workspace`, cheaply, until a push channel replaces it:
 * every 3 s while a build is queued or runs (publishing included), easing
 * to 4 s while consecutive reads come back unchanged and snapping back to
 * 3 s on a change, a focus or an owner action; 30 s
 * otherwise, 60 s after a failed read. A hidden tab with nothing in flight
 * does not poll; with a build in flight it keeps its pace, because a tab
 * can be hidden to the page and still be the one the owner is watching. A
 * tab coming back or gaining focus reads at once. An owner action or the
 * end of a chat turn reads at once too. Each poll sends the last tag, so an
 * unchanged workspace answers 304 and keeps what is shown.
 */
export const INTERVAL = { building: 3_000, idle: 30_000, error: 60_000 }

/**
 * The pace of a build in flight by the number of unchanged reads in a row; the
 * last step holds. Capped at 4 s: at 10 s a ready draft reached the chat up to
 * 20 s after the server had it (2026-10-25), and an unchanged read is a 304.
 */
export const BUILDING_BACKOFF = [INTERVAL.building, INTERVAL.building, 4_000]

/** How long after a review opens the panel keeps a build's pace, for the ready line that follows it. */
export const JUST_READY_MS = 60_000

/** A read that has not answered by now counts as failed, so it cannot hold up every read behind it. */
export const READ_LIMIT_MS = 20_000

type Page = {
  readonly hidden: boolean
  addEventListener: (
    type: "visibilitychange" | "focus",
    listener: () => void
  ) => void
  removeEventListener: (
    type: "visibilitychange" | "focus",
    listener: () => void
  ) => void
}

export type Poller = {
  /** Read now, and again on the schedule from then. */
  refresh: () => Promise<void>
  /** Take a workspace read elsewhere (a loader) as the current one. */
  adopt: (workspace: Workspace | null) => void
  stop: () => void
}

export function startPolling({
  initial,
  read,
  onChange,
  page,
}: {
  initial: Workspace | null
  read: (etag: string | null) => Promise<WorkspacePoll>
  /** A new workspace, or the same one with `failed` set when a read failed. */
  onChange: (workspace: Workspace | null, failed: boolean) => void
  page: Page
}): Poller {
  let current = initial
  let failed = false
  let unchanged = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> | null = null
  // The read queued behind one already under way, shared by every caller
  // who asked while it was.
  let queued: Promise<void> | null = null
  let stopped = false
  // Bumped by `adopt`: a read that began before it answers for an older
  // workspace than the one adopted, so its answer is dropped.
  let generation = 0

  const schedule = () => {
    clearTimeout(timer)
    const busy =
      current?.building ||
      // Queued, or built and taking its screenshots: both move on their own.
      current?.builds.some(
        (b) => b.state === "queued" || b.state === "preview_ready"
      ) ||
      // A review just opened: its ready line is posted a few seconds later.
      current?.attention.some(
        (item) =>
          item.kind === "approval" &&
          Date.now() - Date.parse(item.raisedAt) < JUST_READY_MS
      )
    if (stopped || (page.hidden && !busy)) return
    const delay = failed
      ? INTERVAL.error
      : busy
        ? BUILDING_BACKOFF[Math.min(unchanged, BUILDING_BACKOFF.length - 1)]
        : INTERVAL.idle
    timer = setTimeout(tick, delay)
  }

  const tick = (): Promise<void> => {
    clearTimeout(timer)
    if (inFlight) {
      // A read already under way started before whatever asked for this
      // one, so its answer may be stale: read once more when it lands, and
      // answer the caller only when that read has.
      queued ??= inFlight.then(() => {
        queued = null
        return stopped ? undefined : tick()
      })
      return queued
    }
    const began = generation
    inFlight = (async () => {
      let limit: ReturnType<typeof setTimeout> | undefined
      try {
        const next = await Promise.race([
          read(current?.etag ?? null),
          new Promise<never>((_, reject) => {
            limit = setTimeout(
              () => reject(new Error("read timed out")),
              READ_LIMIT_MS
            )
          }),
        ])
        if (began !== generation) return
        failed = false
        unchanged = next === "unchanged" ? unchanged + 1 : 0
        if (next !== "unchanged") {
          current = next
          onChange(current, false)
        }
      } catch {
        if (began !== generation) return
        failed = true
        unchanged = 0
        onChange(current, true)
      } finally {
        clearTimeout(limit)
      }
    })().finally(() => {
      inFlight = null
      // With a read queued, that read schedules the next one.
      if (!queued) schedule()
    })
    return inFlight
  }

  // Back in view or focused: read now, unless a read is already on its way.
  const onWake = () => {
    if (page.hidden) return schedule()
    unchanged = -1 // the read it starts is not a quiet one
    if (!inFlight) void tick()
  }
  page.addEventListener("visibilitychange", onWake)
  page.addEventListener("focus", onWake)
  schedule()

  return {
    refresh: () => {
      unchanged = -1
      return tick()
    },
    adopt: (workspace) => {
      generation++
      unchanged = 0
      current = workspace
      failed = false
      schedule()
    },
    stop: () => {
      stopped = true
      clearTimeout(timer)
      page.removeEventListener("visibilitychange", onWake)
      page.removeEventListener("focus", onWake)
    },
  }
}

/**
 * What the panel shows after the frame loader read again. A read that failed
 * (`null`) keeps the workspace already on screen, marked stale, rather than
 * blanking the panel until the next poll.
 */
export const afterFrameRead = (
  kept: Workspace | null,
  read: Workspace | null
) => ({
  workspace: read ?? kept,
  failed: read === null,
})

type Live = {
  workspace: Workspace | null
  /** The last read failed; what is shown is the read before it. */
  failed: boolean
  refresh: () => Promise<void>
}

const LiveWorkspace = createContext<Live | null>(null)
export const LiveWorkspaceProvider = LiveWorkspace.Provider

/**
 * The workspace the panel shows, kept fresh. `initial` is the frame
 * loader's read; each new one is adopted, so a navigation does not leave
 * the poll behind it.
 */
export function useLiveWorkspaceState(
  initial: Workspace | null,
  read: (etag: string | null) => Promise<WorkspacePoll>
): Live {
  const [state, setState] = useState({ workspace: initial, failed: false })
  const poller = useRef<Poller | null>(null)

  // The poller lives for the page: later loader reads arrive through
  // `adopt` below, so neither argument restarts it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: started once per page.
  useEffect(() => {
    const started = startPolling({
      initial,
      read,
      onChange: (workspace, failed) => setState({ workspace, failed }),
      page: {
        get hidden() {
          return document.hidden
        },
        // Focus fires on the window, visibility on the document.
        addEventListener: (type, listener) =>
          (type === "focus" ? window : document).addEventListener(
            type,
            listener
          ),
        removeEventListener: (type, listener) =>
          (type === "focus" ? window : document).removeEventListener(
            type,
            listener
          ),
      },
    })
    poller.current = started
    return started.stop
  }, [])

  const adopted = useRef(initial)
  useEffect(() => {
    if (adopted.current === initial) return
    adopted.current = initial
    setState((now) => afterFrameRead(now.workspace, initial))
    // A failed frame read has nothing to adopt: read the poll again now.
    if (initial) poller.current?.adopt(initial)
    else void poller.current?.refresh()
  }, [initial])

  const refresh = useCallback(
    () => poller.current?.refresh() ?? Promise.resolve(),
    []
  )
  return useMemo(() => ({ ...state, refresh }), [state, refresh])
}

/** The live workspace, for anything under the /app frame. */
/** The business's zone from the frame's workspace, or null outside the frame or before one is set. */
export const useBusinessZone = (): string | null =>
  useContext(LiveWorkspace)?.workspace?.timeZone ?? null

export function useLiveWorkspace(): Live {
  const live = useContext(LiveWorkspace)
  if (!live) {
    throw new Error("useLiveWorkspace needs the /app frame around it")
  }
  return live
}
