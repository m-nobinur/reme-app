// @vitest-environment happy-dom
import { ApprovalItem, VersionCard } from "@workspace/ui/components/live-panel"
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

async function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  await act(async () => createRoot(container).render(element))
  return container
}

const render = (extra: object) =>
  mount(
    createElement(ApprovalItem, {
      title: "Brightclean website",
      meta: "Not published",
      onApprove: () => undefined,
      onAskForChanges: () => undefined,
      target: REVISION,
      preview: "error",
      ...extra,
    })
  )

const approve = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "Publish"
  )

it("says a preview that could not be read is not available yet, and reads it again", async () => {
  const onRetryPreview = vi.fn(async () => undefined)
  const container = await render({ preview: "error", onRetryPreview })
  expect(container.textContent).toContain(
    "The preview isn't available yet. Try again in a moment."
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

it("keeps the preview link when only the home page screenshot fails to load", async () => {
  const container = await mount(
    createElement(VersionCard, {
      title: "Brightclean website",
      meta: "Not published",
      onPublish: () => undefined,
      onRequestChanges: () => undefined,
      shot: true,
      preview: {
        url: "https://preview-acme-v4.example.net/open?t=x",
        screenshots: ["a.png", "b.png", "c.png"],
      },
    })
  )
  // Screenshots land after the preview, so a failed one is looked at again
  // every 5 s; only after every look fails does the card give up on it.
  vi.useFakeTimers()
  try {
    for (let look = 0; look < 6 && container.querySelector("img"); look++) {
      await act(async () => {
        container.querySelector("img")?.dispatchEvent(new Event("error"))
      })
      await act(async () => {
        vi.advanceTimersByTime(5000)
      })
    }
  } finally {
    vi.useRealTimers()
  }
  expect(container.querySelector("img")).toBeNull()
  const links = container.querySelectorAll('a[href^="https://preview-acme-v4"]')
  expect(links).toHaveLength(1)
  expect(links[0]?.textContent).toContain("Preview")
  expect(approve(container)?.disabled).toBe(false)
})
