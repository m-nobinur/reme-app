import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react"
import type { Workspace, WorkspacePoll } from "./api/types"

/**
 * The panel polls `/workspace`, cheaply (open item 69 until C8 replaces it):
 * every 3 s while a build runs, 30 s otherwise, 60 s after a failed read. A
 * hidden tab does not poll, and a tab coming back reads at once. An owner
 * action or the end of a chat turn reads at once too. Each poll sends the
 * last tag, so an unchanged workspace answers 304 and keeps what is shown.
 */
export const INTERVAL = { building: 3_000, idle: 30_000, error: 60_000 }

/**
 * Polls per build and how many were 304, for the S exit's numbers. Read from
 * the browser console as `__remeWorkspacePolls`; nothing on screen shows it.
 * `idle` counts the polls with no build running.
 */
export type PollStats = Record<
  string,
  { polls: number; unchanged: number; failed: number }
>

type Page = {
  readonly hidden: boolean
  addEventListener: (type: "visibilitychange", listener: () => void) => void
  removeEventListener: (type: "visibilitychange", listener: () => void) => void
}

export type Poller = {
  /** Read now, and again on the schedule from then. */
  refresh: () => Promise<void>
  /** Take a workspace read elsewhere (a loader) as the current one. */
  adopt: (workspace: Workspace | null) => void
  stop: () => void
  stats: PollStats
}

/** The build a poll is counted against: the first one doing work. */
const statsKey = (workspace: Workspace | null) =>
  (workspace?.building && workspace.builds[0]?.assignment_id) || "idle"

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
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> | null = null
  let again = false
  let stopped = false
  const stats: PollStats = {}

  const schedule = () => {
    clearTimeout(timer)
    if (stopped || page.hidden) return
    const delay = failed
      ? INTERVAL.error
      : current?.building
        ? INTERVAL.building
        : INTERVAL.idle
    timer = setTimeout(tick, delay)
  }

  const count = (field: "polls" | "unchanged" | "failed") => {
    const key = statsKey(current)
    stats[key] ??= { polls: 0, unchanged: 0, failed: 0 }
    stats[key][field]++
  }

  const tick = (): Promise<void> => {
    clearTimeout(timer)
    if (inFlight) {
      // A read already under way started before whatever asked for this
      // one, so its answer may be stale: read once more when it lands.
      again = true
      return inFlight
    }
    inFlight = (async () => {
      count("polls")
      try {
        const next = await read(current?.etag ?? null)
        failed = false
        if (next === "unchanged") {
          count("unchanged")
        } else {
          current = next
          onChange(current, false)
        }
      } catch {
        count("failed")
        failed = true
        onChange(current, true)
      }
    })().finally(() => {
      inFlight = null
      if (again && !stopped) {
        again = false
        void tick()
      } else {
        schedule()
      }
    })
    return inFlight
  }

  const onVisibility = () => {
    if (page.hidden) {
      clearTimeout(timer)
    } else {
      void tick()
    }
  }
  page.addEventListener("visibilitychange", onVisibility)
  schedule()

  return {
    refresh: tick,
    adopt: (workspace) => {
      current = workspace
      failed = false
      schedule()
    },
    stop: () => {
      stopped = true
      clearTimeout(timer)
      page.removeEventListener("visibilitychange", onVisibility)
    },
    stats,
  }
}

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
      page: document,
    })
    poller.current = started
    ;(globalThis as { __remeWorkspacePolls?: PollStats }).__remeWorkspacePolls =
      started.stats
    return started.stop
  }, [])

  const adopted = useRef(initial)
  useEffect(() => {
    if (adopted.current === initial) return
    adopted.current = initial
    poller.current?.adopt(initial)
    setState({ workspace: initial, failed: initial === null })
  }, [initial])

  const refresh = useCallback(
    () => poller.current?.refresh() ?? Promise.resolve(),
    []
  )
  return { ...state, refresh }
}

/** The live workspace, for anything under the /app frame. */
export function useLiveWorkspace(): Live {
  const live = useContext(LiveWorkspace)
  if (!live) {
    throw new Error("useLiveWorkspace needs the /app frame around it")
  }
  return live
}
