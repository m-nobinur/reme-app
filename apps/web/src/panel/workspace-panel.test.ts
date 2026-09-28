// @vitest-environment happy-dom
import type { Conversation, Reminder } from "@workspace/contracts"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { Workspace } from "@/lib/api/types"
import { EMPTY_WORKSPACE } from "@/lib/attention"
import { WorkspacePanel } from "./workspace-panel"

/**
 * Where each blank section's next step goes, as the app wires it. The
 * catalog clicks the same actions with made-up links, and the smoke owner
 * reaches only "Start your website", so this is what fails when the app hands
 * a blank section the wrong destination. A link renders as an anchor that
 * names its route, params and state.
 */

type LinkProps = {
  to: string
  params?: Record<string, string>
  state?: unknown
  children?: ReactNode
}

vi.mock("@tanstack/react-router", () => ({
  getRouteApi: () => ({ useLoaderData: () => loader }),
  Link: ({ to, params, children }: LinkProps) =>
    createElement(
      "a",
      { "data-to": to, "data-params": JSON.stringify(params ?? null) },
      children
    ),
}))
vi.mock("@/lib/workspace", () => ({ useLiveWorkspace: () => live }))
vi.mock("@/lib/api/server", () => server)

const server = vi.hoisted(() => ({
  completeReminder: vi.fn(),
  createReminder: vi.fn(),
}))

const ONBOARDING = "00000000-0000-4000-8000-00000000000a"

let loader: {
  conversations: Conversation[]
  names: Record<string, string>
  active: { id: string } | null
}
let live: {
  workspace: Workspace | null
  failed: boolean
  refresh: () => Promise<void>
}
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  loader = {
    conversations: [],
    names: {},
    active: { id: "00000000-0000-4000-8000-000000000001" },
  }
  server.completeReminder.mockReset()
  server.createReminder.mockReset()
  live = { workspace: EMPTY_WORKSPACE, failed: false, refresh: vi.fn() }
  container = document.createElement("div")
  document.body.appendChild(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function render() {
  root = createRoot(container)
  await act(async () => root.render(createElement(WorkspacePanel)))
}

const link = (name: string) =>
  [...container.querySelectorAll("a")].find(
    (anchor) => anchor.textContent === name
  )

it('sends "See notifications" to the notifications page', async () => {
  live.workspace = { ...EMPTY_WORKSPACE, live: 2 }
  await render()
  expect(link("See notifications")?.dataset.to).toBe("/app/notifications")
})

it('sends "Continue getting started" to the onboarding conversation', async () => {
  loader.conversations = [
    {
      id: ONBOARDING,
      kind: "onboarding",
      archived_at: null,
    } as unknown as Conversation,
  ]
  await render()
  const next = link("Continue getting started")
  expect(next?.dataset.to).toBe("/app/c/$id")
  expect(JSON.parse(next?.dataset.params ?? "null")).toEqual({
    id: ONBOARDING,
  })
})

it('reads the workspace again on "Try again"', async () => {
  live.workspace = null
  live.failed = true
  const refresh = vi.fn(async () => undefined)
  live.refresh = refresh
  await render()
  const retry = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Try again"
  )
  await act(async () => retry?.click())
  expect(refresh).toHaveBeenCalledOnce()
})

const note = (id: string, title: string, due_at: string | null): Reminder => ({
  id,
  title,
  due_at,
  done_at: null,
  source: "owner",
  conversation_id: null,
  created_at: "2026-09-26T10:00:00.000Z",
  updated_at: "2026-09-26T10:00:00.000Z",
})
const CLOTHS = "00000000-0000-4000-8000-00000000000b"
const VAN = "00000000-0000-4000-8000-00000000000c"

const buttonNamed = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (element) =>
      (element.getAttribute("aria-label") ?? element.textContent) === name
  )

/** A promise the test settles, to look at the screen while a write runs. */
function deferred<T>() {
  let settle!: { resolve: (value: T) => void; reject: (error: Error) => void }
  const promise = new Promise<T>((resolve, reject) => {
    settle = { resolve, reject }
  })
  return { promise, ...settle }
}

it("lists written reminders first, in the api's order, then derived ones", async () => {
  live.workspace = {
    ...EMPTY_WORKSPACE,
    live: 2,
    reminderNotes: [
      note(CLOTHS, "Order more cloths", "2026-10-02T09:00:00.000Z"),
      note(VAN, "Book the van's MOT", null),
    ],
    derivedReminders: [{ rule: "facts_missing", keys: ["business.phone"] }],
  }
  await render()
  const section = container.querySelector('section:has(> h2[tabindex="-1"])')
  const rows = [...(section?.querySelectorAll("li") ?? [])].map(
    (row) => row.querySelector("span")?.textContent
  )
  expect(rows).toEqual([
    "Order more cloths",
    "Book the van's MOT",
    "Tell Reme your phone number",
  ])
})

it("shows a reminder done at once, and puts it back when that fails", async () => {
  live.workspace = {
    ...EMPTY_WORKSPACE,
    live: 2,
    reminderNotes: [note(CLOTHS, "Order more cloths", null)],
  }
  const write = deferred<unknown>()
  server.completeReminder.mockReturnValueOnce(write.promise)
  await render()
  const row = () => container.querySelector('[data-slot="reminder-note"]')

  await act(async () => buttonNamed("Done: Order more cloths")?.click())
  expect(server.completeReminder).toHaveBeenCalledWith({ data: { id: CLOTHS } })
  expect(row()?.getAttribute("data-state")).toBe("done")

  await act(async () => write.reject(new Error("offline")))
  expect(row()?.getAttribute("data-state")).toBe("open")
  expect(row()?.querySelector('[role="alert"]')?.textContent).toBe(
    "That did not go through. Try again."
  )
  expect(live.refresh).not.toHaveBeenCalled()

  server.completeReminder.mockResolvedValueOnce({ done: true })
  await act(async () => buttonNamed("Done: Order more cloths")?.click())
  expect(live.refresh).toHaveBeenCalledOnce()
})

it("sends one key per reminder: the same on a retry, a new one once added", async () => {
  await render()
  const add = async (title: string) => {
    const input = container.querySelector<HTMLInputElement>('[name="title"]')
    if (input) input.value = title
    await act(async () =>
      container
        .querySelector<HTMLFormElement>('[data-slot="add-reminder"]')
        ?.requestSubmit()
    )
  }
  const keys = () =>
    server.createReminder.mock.calls.map(
      ([call]) => (call as { data: { key: string } }).data.key
    )

  server.createReminder.mockRejectedValueOnce(new Error("timed out"))
  await add("Order more cloths")
  server.createReminder.mockResolvedValueOnce({ done: true })
  await add("Order more cloths")
  server.createReminder.mockResolvedValueOnce({ done: true })
  await add("Order more cloths")
  server.createReminder.mockResolvedValueOnce({
    done: false,
    reason: "Pick a time within a year.",
  })
  await add("Book the van's MOT")

  const [first, retry, again, other] = keys()
  expect(retry).toBe(first)
  expect(again).not.toBe(first)
  expect(other).not.toBe(again)
  expect(server.createReminder.mock.calls[0]?.[0]).toMatchObject({
    data: { title: "Order more cloths", dueAt: null },
  })
  // A refusal is shown in place, and what was typed stays.
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Pick a time within a year."
  )
  expect(
    container.querySelector<HTMLInputElement>('[name="title"]')?.value
  ).toBe("Book the van's MOT")
})

it("offers no add form to an owner with no organisation", async () => {
  loader.active = null
  await render()
  expect(container.querySelector('[data-slot="add-reminder"]')).toBeNull()
  expect(container.textContent).not.toContain("Nothing to remember yet")

  await act(async () => root.unmount())
  loader.active = { id: "00000000-0000-4000-8000-000000000001" }
  await render()
  expect(container.querySelector('[data-slot="add-reminder"]')).not.toBeNull()
})

it("moves focus to the section heading when a completed reminder leaves", async () => {
  live.workspace = {
    ...EMPTY_WORKSPACE,
    live: 2,
    reminderNotes: [note(CLOTHS, "Order more cloths", null)],
  }
  server.completeReminder.mockResolvedValueOnce({ done: true })
  await render()
  const done = buttonNamed("Done: Order more cloths")
  done?.focus()
  await act(async () => done?.click())

  // The read after the write no longer lists it.
  live.workspace = { ...live.workspace, reminderNotes: [] }
  await act(async () => root.render(createElement(WorkspacePanel)))
  expect(document.activeElement?.tagName).toBe("H2")
  expect(document.activeElement?.textContent).toBe("Reminders")
})
