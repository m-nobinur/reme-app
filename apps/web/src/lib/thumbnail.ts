import type { Thumbnail } from "@workspace/ui/components/live-panel"
import type { PreviewLinks, Workspace } from "./api/types"

/**
 * The screenshot "Your website" shows: the desktop one. The api lists a
 * preview's screenshots at 390, 768 and 1440 wide, in that order (the
 * orchestrator maps `SCREENSHOTS` in packages/gates), and the approval
 * item labels them phone, tablet and laptop by the same index.
 */
const DESKTOP = 2

/** How long before a preview's signature lapses its links are read again. */
export const REFRESH_BEFORE_EXPIRY = 5 * 60_000

/** The soonest a re-read runs, so links close to expiry never loop. */
export const REFRESH_FLOOR = 60_000

type LiveRevision = Workspace["liveRevision"]

export type ThumbnailFollower = {
  /** The live revision now; a revision already shown is not read again. */
  show: (live: LiveRevision) => void
  stop: () => void
}

/**
 * Reads the live revision's preview once per revision, and again before
 * its signed links expire. A preview of any other revision shows nothing,
 * and so does a failed read: the section keeps its text.
 */
export function followThumbnail({
  read,
  onChange,
}: {
  read: (assignmentId: string) => Promise<PreviewLinks | null>
  onChange: (thumbnail: Thumbnail) => void
}): ThumbnailFollower {
  let shown: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  // Bumped whenever the revision changes or the follower stops, so a read
  // that began for an earlier one is dropped when it lands.
  let generation = 0

  const fetch = async (live: NonNullable<LiveRevision>) => {
    const began = generation
    const link = await read(live.assignmentId).catch(() => null)
    if (began !== generation) return
    if (link?.revisionId !== live.revisionId) {
      onChange(null)
      return
    }
    onChange({ src: link.screenshots[DESKTOP] })
    const delay =
      Date.parse(link.expiresAt) - Date.now() - REFRESH_BEFORE_EXPIRY
    timer = setTimeout(() => void fetch(live), Math.max(REFRESH_FLOOR, delay))
  }

  return {
    show: (live) => {
      if ((live?.revisionId ?? null) === shown) return
      shown = live?.revisionId ?? null
      generation++
      clearTimeout(timer)
      if (!live) {
        onChange(null)
        return
      }
      onChange("loading")
      void fetch(live)
    },
    stop: () => {
      shown = null
      generation++
      clearTimeout(timer)
    },
  }
}
