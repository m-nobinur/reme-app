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

/**
 * Dots the face's tab icons while `badge` holds, filled when waiting and a
 * ring when working, so another tab shows whether the owner is needed.
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
      const tokens = getComputedStyle(document.documentElement)
      context.drawImage(image, 0, 0, SIZE, SIZE)
      context.beginPath()
      context.arc(SIZE - 14, SIZE - 14, 12, 0, Math.PI * 2)
      context.fillStyle = tokens.getPropertyValue("--background")
      context.fill()
      context.beginPath()
      context.arc(SIZE - 14, SIZE - 14, 8, 0, Math.PI * 2)
      context.fillStyle = context.strokeStyle =
        tokens.getPropertyValue("--primary")
      context.lineWidth = 4
      if (badge === "waiting") context.fill()
      else context.stroke()
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
