// @vitest-environment happy-dom
import type { Conversation, Reminder } from "@workspace/contracts"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { Workspace } from "@/lib/api/types"
import { EMPTY_WORKSPACE } from "@/lib/attention"
import { lineOf, WorkspacePanel } from "./workspace-panel"

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
const PAST = "00000000-0000-4000-8000-00000000000e"

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

const tab = (name: string) =>
  [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((element) =>
    element.textContent?.startsWith(name)
  )

it("lists only reminders still ahead, under a tab that counts them", async () => {
  live.workspace = {
    ...EMPTY_WORKSPACE,
    live: 2,
    reminderNotes: [
      note(PAST, "Ring the landlord", "2020-10-01T09:00:00.000Z"),
      note(CLOTHS, "Order more cloths", "2099-10-02T09:00:00.000Z"),
      note(VAN, "Book the van's MOT", null),
    ],
    derivedReminders: [{ rule: "facts_missing", keys: ["business.phone"] }],
  }
  await render()
  expect(tab("Activity")?.getAttribute("aria-selected")).toBe("true")
  expect(tab("Reminders")?.textContent).toBe("Reminders2")
  await act(async () => tab("Reminders")?.click())
  const rows = [
    ...container.querySelectorAll('[data-slot="reminder-note"]'),
  ].map((row) => row.querySelector("span")?.textContent)
  expect(rows).toEqual(["Order more cloths", "Book the van's MOT"])
  // Derived reminders repeat "Waiting on you", so the panel does not list them.
  expect(container.textContent).not.toContain("Tell Reme")
})

it("has no Reminders tab, and no add form, with nothing ahead", async () => {
  live.workspace = {
    ...EMPTY_WORKSPACE,
    live: 2,
    host: "brightclean-demo.example.invalid",
    reminderNotes: [
      note(PAST, "Ring the landlord", "2020-10-01T09:00:00.000Z"),
    ],
  }
  await render()
  expect(
    [...container.querySelectorAll('[role="tab"]')].map(
      (element) => element.textContent
    )
  ).toEqual(["Activity", "Website"])
  expect(container.querySelector('[name="title"]')).toBeNull()
})

it("links the live site by name, with the host as its title", async () => {
  live.workspace = {
    ...EMPTY_WORKSPACE,
    live: 3,
    host: "brightclean-demo.example.invalid",
  }
  await render()
  await act(async () => tab("Website")?.click())
  const visit = [...container.querySelectorAll("a")].find((anchor) =>
    anchor.textContent?.startsWith("Visit your website")
  )
  expect(visit?.getAttribute("href")).toBe(
    "https://brightclean-demo.example.invalid"
  )
  expect(visit?.title).toBe("brightclean-demo.example.invalid")
  expect(visit?.target).toBe("_blank")
  expect(visit?.rel).toBe("noreferrer")
  expect(container.textContent).toContain("Version 3 is live")
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
  await act(async () => tab("Reminders")?.click())
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

it("moves focus to the Activity tab when the last reminder is done", async () => {
  live.workspace = {
    ...EMPTY_WORKSPACE,
    live: 2,
    reminderNotes: [note(CLOTHS, "Order more cloths", null)],
  }
  server.completeReminder.mockResolvedValueOnce({ done: true })
  await render()
  await act(async () => tab("Reminders")?.click())
  const done = buttonNamed("Done: Order more cloths")
  done?.focus()
  await act(async () => done?.click())

  // The read after the write no longer lists it, so its tab goes too.
  live.workspace = { ...live.workspace, reminderNotes: [] }
  await act(async () => root.render(createElement(WorkspacePanel)))
  expect(tab("Reminders")).toBeUndefined()
  expect(document.activeElement).toBe(tab("Activity"))
  expect(tab("Activity")?.getAttribute("aria-selected")).toBe("true")
})

const ORG = { id: "00000000-0000-4000-8000-000000000001", name: "Brightclean" }
const build = (state: string, version: number | null) =>
  ({
    assignment_id: "00000000-0000-4000-8000-00000000000d",
    goal: "Add Saturday hours",
    state,
    revision: version ? { version } : null,
    created_at: "2026-09-30T09:00:00.000Z",
  }) as unknown as Workspace["builds"][number]

it("says in one line what is most pressing", () => {
  const org = ORG as unknown as Parameters<typeof lineOf>[1]
  expect(
    lineOf(
      {
        ...EMPTY_WORKSPACE,
        live: 2,
        builds: [build("validating", 3)],
        attention: [{ kind: "question" } as never],
      },
      org
    )
  ).toEqual({
    tone: "working",
    lead: "Building version 3,",
    detail: "checking the site",
  })
  // A build waiting on the owner is not being worked on.
  expect(
    lineOf(
      {
        ...EMPTY_WORKSPACE,
        live: 2,
        builds: [build("blocked_on_approval", 3)],
        attention: [
          { kind: "approval" } as never,
          { kind: "question" } as never,
        ],
      },
      org
    )
  ).toEqual({ tone: "live", lead: "2 things", detail: "waiting on you" })
  expect(lineOf({ ...EMPTY_WORKSPACE, live: 1 }, org)).toEqual({
    tone: "live",
    lead: "Brightclean,",
    detail: "site live on v1",
  })
  expect(lineOf(EMPTY_WORKSPACE, org)).toEqual({
    tone: "idle",
    lead: "Brightclean,",
    detail: "no site yet",
  })
  expect(lineOf(EMPTY_WORKSPACE, null)).toEqual({
    tone: "idle",
    lead: "Nothing published yet",
  })
  expect(lineOf(null, org).tone).toBe("idle")
})
