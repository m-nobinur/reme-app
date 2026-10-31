// @vitest-environment happy-dom
import { WorkspaceShell } from "@workspace/ui/components/workspace-shell"
import { act, createElement, type FC, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { Route } from "@/routes/app/notifications"
import type { AttentionItem, Workspace } from "./api/types"
import { EMPTY_WORKSPACE } from "./attention"
import { seenCookie } from "./notifications"
import { anchorOf } from "./reminders"

/**
 * The notifications page as wired: which cookie it writes, when, and where
 * its "Show the question" link goes, and the shell opening the panel that
 * link asks for. A link renders as an anchor that names its route, state
 * and hash.
 */

type LinkProps = {
  to: string
  state?: unknown
  hash?: string
  children?: ReactNode
}

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: object) => ({ options }),
  getRouteApi: () => ({ useLoaderData: () => loader }),
  Link: ({ to, state, hash, children }: LinkProps) =>
    createElement(
      "a",
      {
        "data-to": to,
        "data-state": JSON.stringify(
          (typeof state === "function" ? state({}) : state) ?? null
        ),
        "data-hash": hash,
      },
      children
    ),
}))
vi.mock("@/lib/workspace", () => ({
  useLiveWorkspace: () => ({ workspace }),
}))

const ORG_A = "00000000-0000-4000-8000-00000000000a"
const ORG_B = "00000000-0000-4000-8000-00000000000b"
const QUESTION = "00000000-0000-4000-8000-000000000001"
const NEWEST = "2026-10-01T09:00:00.000Z"

const question = {
  kind: "question",
  id: QUESTION,
  title: "Weekday hours",
  detail: "The contact section shows when you are open.",
  raisedAt: NEWEST,
  expiresAt: null,
  onExpiry: "The build waits on you until you answer.",
} as unknown as AttentionItem

const report = {
  kind: "report",
  id: "report",
  title: "Published v3",
  detail: "Version 3 is live on your site.",
  raisedAt: "2026-09-30T09:00:00.000Z",
  expiresAt: null,
  onExpiry: "Nothing to decide.",
} as unknown as AttentionItem

let loader: {
  activity: AttentionItem[] | null
  seenAt: string | null
  active: { id: string } | null
}
let workspace: Workspace | null
let written: string[]
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  loader = { activity: [report], seenAt: null, active: { id: ORG_A } }
  workspace = { ...EMPTY_WORKSPACE, attention: [question] }
  written = []
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get: () => "",
    set: (value: string) => written.push(value),
  })
  container = document.createElement("div")
  document.body.appendChild(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  // Back to happy-dom's own accessor on the prototype.
  delete (document as { cookie?: string }).cookie
})

async function render() {
  const Page = (Route as unknown as { options: { component: FC } }).options
    .component
  root = createRoot(container)
  await act(async () => root.render(createElement(Page)))
}

/** The cookie names the page wrote, with their values. */
const cookies = () =>
  Object.fromEntries(
    written.map((each) => each.split(";")[0]?.split("=") as [string, string])
  )

it("marks the newest item seen once everything has loaded", async () => {
  await render()
  expect(cookies()).toEqual({ [seenCookie(ORG_A)]: NEWEST })
})

it("marks nothing seen while the /activity read failed", async () => {
  loader.activity = null
  await render()
  // The question is on screen, but a report that failed to load may be
  // newer than the last one seen: marking now would hide it.
  expect(container.textContent).toContain("Weekday hours")
  expect(written).toEqual([])
})

it("marks nothing seen while the /workspace read failed", async () => {
  workspace = null
  await render()
  expect(container.textContent).toContain("Published v3")
  expect(written).toEqual([])
})

it("marks only the organisation on screen as seen", async () => {
  await render()
  // What the frame loader reads for org B is untouched by seeing org A.
  expect(seenCookie(ORG_A)).not.toBe(seenCookie(ORG_B))
  expect(cookies()[seenCookie(ORG_B)]).toBeUndefined()
})

it("opens the panel on the question, with nothing about it in the address", async () => {
  await render()
  const answer = [...container.querySelectorAll("a")].find(
    (anchor) => anchor.textContent === "Show the question"
  )
  expect(answer?.dataset.to).toBe("/app")
  expect(answer?.dataset.hash).toBeUndefined()
  expect(JSON.parse(answer?.dataset.state ?? "null")).toEqual({
    panel: { key: expect.any(String), focus: anchorOf.question(QUESTION) },
  })
})

for (const [width, wide] of [
  ["from lg", true],
  ["below lg", false],
] as const) {
  it(`opens a closed panel on arrival ${width}`, async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: wide,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }))
    root = createRoot(container)
    await act(async () =>
      root.render(
        createElement(WorkspaceShell, {
          defaultPanelOpen: false,
          openPanel: { key: "press" },
          panel: "Waiting on you",
          panelLine: "2 waiting on you",
          rail: null,
          // biome-ignore lint/correctness/noChildrenProp: the shell's props type requires children, so createElement needs them here to type-check.
          children: null,
        })
      )
    )
    const panel = document.getElementById("workspace-panel")
    expect(panel?.dataset.state).toBe("open")
    expect(panel?.textContent).toContain("Waiting on you")
    vi.unstubAllGlobals()
  })
}
