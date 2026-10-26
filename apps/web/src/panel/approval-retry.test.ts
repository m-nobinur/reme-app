// @vitest-environment happy-dom
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const server = vi.hoisted(() => ({
  getPreview: vi.fn(),
  decideApproval: vi.fn(),
  askForChanges: vi.fn(),
}))
vi.mock("@/lib/api/server", () => server)
vi.mock("@tanstack/react-router", () => ({
  getRouteApi: () => ({ useLoaderData: () => ({}) }),
  Link: () => null,
  useParams: () => ({}),
}))

const { Decidable } = await import("./workspace-panel")

const BUILD = "3c4d5e6f-7081-4c9d-8e0f-1a2b3c4d5e6f"
const ITEM = {
  kind: "approval",
  id: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d",
  version: 4,
  detail: "The hero now leads with end of tenancy cleans.",
  onExpiry: "Nothing is published without you.",
  request: {
    approval_id: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d",
    assignment_id: BUILD,
    expires_at: "2026-10-02T09:00:00.000Z",
    target: {
      kind: "revision",
      revision_id: "9c3e1f2a-4b5d-4e6f-8a7b-1c2d3e4f5a6b",
    },
  },
} as unknown as Parameters<typeof Decidable>[0]["item"]

it("reads a preview that failed again when the owner asks, and then offers it", async () => {
  server.getPreview
    .mockRejectedValueOnce(new Error("503"))
    .mockResolvedValueOnce({
      url: "https://preview-acme-v4.example.net/open?t=x",
    })
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () =>
    root.render(
      createElement(Decidable, {
        item: ITEM,
        refresh: async () => undefined,
        announce: () => undefined,
      })
    )
  )
  const again = await vi.waitFor(() => {
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Retry preview"
    )
    expect(button).toBeDefined()
    return button
  })
  await act(async () => again?.click())
  await vi.waitFor(() =>
    expect(
      container.querySelector('a[href^="https://preview-acme-v4"]')
    ).not.toBeNull()
  )
  expect(server.getPreview).toHaveBeenCalledTimes(2)
  expect(server.getPreview).toHaveBeenLastCalledWith({
    data: { assignmentId: BUILD },
  })
  await act(async () => root.unmount())
})
