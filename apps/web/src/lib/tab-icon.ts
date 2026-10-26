import { useEffect } from "react"
import type { Workspace } from "./api/types"

/** What the tab's dot says: something waits on the owner, or the assistant is at work. */
export type TabBadge = "waiting" | "working" | null

export function tabBadge(workspace: Workspace | null): TabBadge {
  if (!workspace) return null
  const { activity } = workspace
  const journey = activity?.journey ?? []
  if (
    workspace.attention.length > 0 ||
    (activity?.waiting.length ?? 0) > 0 ||
    journey.some((s) => s.state === "waiting")
  )
    return "waiting"
  // Onboarding "now" is a question asked in words, not work.
  if (
    workspace.building ||
    (activity?.now.length ?? 0) > 0 ||
    journey.some((s) => s.kind !== "onboarding" && s.state === "now")
  )
    return "working"
  return null
}

const SIZE = 64
/** The dot sits on the circle's lower right, as a presence dot does. */
const DOT = { x: 52, y: 52, r: 10, gap: 4 }

/**
 * The face's tab icons redrawn with a presence dot while `badge` holds:
 * amber when something waits on the owner, green while work runs, cut
 * clear of the face so it reads on a light or dark tab strip. Put back when
 * it clears.
 */
export function useTabBadge(face: string | undefined, badge: TabBadge) {
  useEffect(() => {
    if (!face || !badge) return
    const links = [
      ...document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]'),
    ]
    let drawn: string | null = null
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement("canvas")
      canvas.width = canvas.height = SIZE
      const context = canvas.getContext("2d")
      if (!context) return
      context.drawImage(image, 0, 0, SIZE, SIZE)
      context.globalCompositeOperation = "destination-out"
      context.beginPath()
      context.arc(DOT.x, DOT.y, DOT.r + DOT.gap, 0, Math.PI * 2)
      context.fill()
      context.globalCompositeOperation = "source-over"
      context.beginPath()
      context.arc(DOT.x, DOT.y, DOT.r, 0, Math.PI * 2)
      context.fillStyle = getComputedStyle(
        document.documentElement
      ).getPropertyValue(`--presence-${badge}`)
      context.fill()
      drawn = canvas.toDataURL("image/png")
      for (const link of links) {
        link.dataset.face = link.href
        link.href = drawn
      }
    }
    image.src = face
    return () => {
      image.onload = null
      // Only links still showing the dot: a new face is already the head's.
      for (const link of links) {
        if (drawn && link.href === drawn && link.dataset.face) {
          link.href = link.dataset.face
        }
      }
    }
  }, [face, badge])
}
