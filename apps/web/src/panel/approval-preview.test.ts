// @vitest-environment happy-dom
import { ApprovalItem } from "@workspace/ui/components/live-panel"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

/**
 * An approval whose preview did not come through still names what the
 * owner can do: open the preview when there is one, try the read again when
 * there is not, and approve either way, since the decision is theirs.
 */

const REVISION = {
  kind: "revision",
  revision_id: "9c3e1f2a-4b5d-4e6f-8a7b-1c2d3e4f5a6b",
} as const

afterEach(() => {
  document.body.innerHTML = ""
})

async function render(extra: object) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  await act(async () =>
    createRoot(container).render(
      createElement(ApprovalItem, {
        expiresAt: "2026-10-02T09:00:00.000Z",
        onApprove: () => undefined,
        onAskForChanges: () => undefined,
        onExpiry: "Nothing is published without you.",
        rationale: "The hero now leads with end of tenancy cleans.",
        target: REVISION,
        version: 4,
        preview: "error",
        ...extra,
      })
    )
  )
  return container
}

const approve = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith("Approve and publish")
  )

it("says a preview that could not be read is not available yet, and reads it again", async () => {
  const onRetryPreview = vi.fn(async () => undefined)
  const container = await render({ preview: "error", onRetryPreview })
  expect(container.textContent).toContain(
    "The preview for version 4 isn't available yet. Try again in a moment."
  )
  // No link is implied where there is none.
  expect(container.textContent).not.toContain("Open the preview")
  expect(container.querySelector("a")).toBeNull()
  const again = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "Try again"
  )
  await act(async () => again?.click())
  expect(onRetryPreview).toHaveBeenCalledOnce()
  expect(approve(container)?.disabled).toBe(false)
})

it("offers the preview link when only the screenshots fail to load", async () => {
  const container = await render({
    preview: {
      url: "https://preview-acme-v4.example.net/open?t=x",
      screenshots: ["a.png", "b.png", "c.png"],
    },
  })
  const shot = container.querySelector("img")
  await act(async () => {
    shot?.dispatchEvent(new Event("error"))
  })
  expect(container.querySelector("img")).toBeNull()
  expect(container.textContent).toContain(
    "The screenshots did not load. Open the preview to see version 4."
  )
  expect(
    container.querySelector('a[href^="https://preview-acme-v4"]')?.textContent
  ).toContain("Open preview")
  expect(approve(container)?.disabled).toBe(false)
})
