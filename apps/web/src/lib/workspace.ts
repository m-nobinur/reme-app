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
 * every 3 s while a build is queued or runs, 30 s otherwise, 60 s after a failed read. A
 * hidden tab does not poll, and a tab coming back reads at once. An owner
 * action or the end of a chat turn reads at once too. Each poll sends the
 * last tag, so an unchanged workspace answers 304 and keeps what is shown.
 */
export const INTERVAL = { building: 3_000, idle: 30_000, error: 60_000 }

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
    if (stopped || page.hidden) return
    const delay = failed
      ? INTERVAL.error
      : current?.building || current?.builds.some((b) => b.state === "queued")
        ? INTERVAL.building
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
      try {
        const next = await read(current?.etag ?? null)
        if (began !== generation) return
        failed = false
        if (next !== "unchanged") {
          current = next
          onChange(current, false)
        }
      } catch {
        if (began !== generation) return
        failed = true
        onChange(current, true)
      }
    })().finally(() => {
      inFlight = null
      // With a read queued, that read schedules the next one.
      if (!queued) schedule()
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
      generation++
      current = workspace
      failed = false
      schedule()
    },
    stop: () => {
      stopped = true
      clearTimeout(timer)
      page.removeEventListener("visibilitychange", onVisibility)
    },
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
  return useMemo(() => ({ ...state, refresh }), [state, refresh])
}

/** The live workspace, for anything under the /app frame. */
export function useLiveWorkspace(): Live {
  const live = useContext(LiveWorkspace)
  if (!live) {
    throw new Error("useLiveWorkspace needs the /app frame around it")
  }
  return live
}
