// @vitest-environment happy-dom
import { act, createElement, type FC } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { Route } from "@/routes/app/approvals"
import type { AttentionItem } from "./api/types"
import { EMPTY_WORKSPACE } from "./attention"

/**
 * The approvals page decides through the panel's own component, from the
 * frame's live workspace: the same buttons, the same pending words, and the
 * workspace read again once the decision is recorded.
 */
;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const server = vi.hoisted(() => ({
  getPreview: vi.fn(async () => null),
  decideApproval: vi.fn(),
  askForChanges: vi.fn(),
}))
vi.mock("@/lib/api/server", () => server)
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: object) => ({
    options,
    useSearch: () => ({}),
    useNavigate: () => () => undefined,
  }),
  getRouteApi: () => ({ useLoaderData: () => ({ names: {} }) }),
  Link: () => null,
  // The panel reads the open conversation, which no page here has.
  useParams: () => ({}),
}))
const refresh = vi.fn(async () => undefined)
vi.mock("@/lib/workspace", () => ({
  useLiveWorkspace: () => ({
    workspace: { ...EMPTY_WORKSPACE, attention: [APPROVAL] },
    refresh,
  }),
}))

const REVISION = "9c3e1f2a-4b5d-4e6f-8a7b-1c2d3e4f5a6b"
const APPROVAL = vi.hoisted(
  () =>
    ({
      kind: "approval",
      id: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d",
      title: "Your new version is ready to publish",
      version: 4,
      detail: "The hero now leads with end of tenancy cleans.",
      raisedBy: "Reme",
      raisedById: null,
      onExpiry: "Nothing is published without you.",
      request: {
        approval_id: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d",
        assignment_id: "3c4d5e6f-7081-4c9d-8e0f-1a2b3c4d5e6f",
        action_kind: "site.publish",
        expires_at: "2026-10-02T09:00:00.000Z",
        target: {
          kind: "revision",
          revision_id: "9c3e1f2a-4b5d-4e6f-8a7b-1c2d3e4f5a6b",
        },
      },
    }) as unknown as AttentionItem
)

it("decides the way the panel does, and reads the workspace again", async () => {
  let record: (value: { recorded: true }) => void = () => undefined
  server.decideApproval.mockReturnValueOnce(
    new Promise((resolve) => {
      record = resolve
    })
  )
  const Page = (Route as unknown as { options: { component: FC } }).options
    .component
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(createElement(Page)))

  const button = (name: string) =>
    [...container.querySelectorAll("button")].find(
      (each) => each.textContent === name
    )
  expect(button("Ask for changes")).toBeDefined()
  await act(async () => button("Approve and publish")?.click())
  expect(button("Publishing")?.disabled).toBe(true)
  expect(server.decideApproval).toHaveBeenCalledWith({
    data: {
      approvalId: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d",
      revisionId: REVISION,
      decision: "approved",
    },
  })
  await act(async () => record({ recorded: true }))
  expect(refresh).toHaveBeenCalledOnce()
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "Approved. Your website is being published."
  )
  await act(async () => root.unmount())
  container.remove()
})
