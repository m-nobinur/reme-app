import type { PanelAuto } from "@workspace/ui/lib/panel"
import { useEffect, useState } from "react"
import type { Workspace } from "./api/types"
import { settingUp } from "./onboarding"

/** An automatic open waits this long after the owner closed the panel. */
export const REOPEN_AFTER_MS = 60_000

/** The panel folds this long after the last job at work finishes. */
export const FOLD_AFTER_MS = 5_000

/** What is at work and what waits on the owner, by id, on any page. */
type Seen = { working: Set<string>; waiting: Set<string> }

export function seenIn({ activity, attention }: Workspace): Seen {
  const segments = [...(activity?.journey ?? []), ...(activity?.now ?? [])]
  return {
    working: new Set(
      segments.filter((each) => each.state === "now").map((each) => each.id)
    ),
    waiting: new Set([
      ...segments
        .filter((each) => each.state === "waiting")
        .map(({ id }) => id),
      ...(activity?.waiting ?? []).map((each) => each.id),
      ...attention
        .filter((item) => item.kind === "approval" || item.kind === "question")
        .map((item) => item.id),
    ]),
  }
}

const arrived = (before: Set<string>, now: Set<string>) =>
  [...now].some((id) => !before.has(id))

export type AutoPanel = {
  /** The workspace as just read. */
  watch: (workspace: Workspace) => void
  /** The owner opened or closed the panel themselves. */
  toggled: (open: boolean) => void
  stop: () => void
}

/**
 * Opens the panel when something new needs the owner or a job starts, and
 * folds it again once the work is over. The owner's say wins: after they
 * close it, it stays closed for `REOPEN_AFTER_MS`, and a panel they opened
 * or closed themselves is never folded for them. It also stays open while
 * anything waits on the owner or setup is open. The first read only sets what is already
 * there, so a page load never opens it.
 */
export function autoPanel(send: (open: boolean) => void): AutoPanel {
  let before: Seen | null = null
  let closedAt: number | null = null
  // Opened here and not touched since: the only panel this folds.
  let ours = false
  let timer: ReturnType<typeof setTimeout> | undefined

  return {
    watch: (workspace) => {
      const now = seenIn(workspace)
      const news =
        before !== null &&
        (arrived(before.working, now.working) ||
          arrived(before.waiting, now.waiting))
      before = now
      if (
        news &&
        (closedAt === null || Date.now() - closedAt >= REOPEN_AFTER_MS)
      ) {
        ours = true
        send(true)
      }
      const over =
        now.working.size === 0 &&
        now.waiting.size === 0 &&
        !settingUp(workspace)
      if (ours && over) {
        // Kept running across reads, which come every few seconds.
        timer ??= setTimeout(() => {
          timer = undefined
          ours = false
          send(false)
        }, FOLD_AFTER_MS)
      } else {
        clearTimeout(timer)
        timer = undefined
      }
    },
    toggled: (open) => {
      ours = false
      closedAt = open ? null : Date.now()
      clearTimeout(timer)
      timer = undefined
    },
    stop: () => clearTimeout(timer),
  }
}

/** `autoPanel` for the shell: what to ask of it, and how it hears the owner's own presses. */
export function useAutoPanel(workspace: Workspace | null) {
  const [request, setRequest] = useState<PanelAuto | undefined>()
  const [auto] = useState(() =>
    autoPanel((open) => setRequest({ key: crypto.randomUUID(), open }))
  )
  useEffect(() => {
    if (workspace) auto.watch(workspace)
  }, [auto, workspace])
  useEffect(() => auto.stop, [auto])
  return { request, toggled: auto.toggled }
}
