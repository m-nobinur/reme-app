// @vitest-environment happy-dom
import type { Conversation, Reminder } from "@workspace/contracts"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { Workspace } from "@/lib/api/types"
import { EMPTY_WORKSPACE } from "@/lib/attention"
import {
  firstAsk,
  PanelAnnouncer,
  useAnnouncement,
  usePanel,
  WorkspacePanel,
} from "./workspace-panel"

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
  useRouter: () => router,
  useMatches: ({ select }: { select: (matches: unknown[]) => unknown }) =>
    select([{ routeId: "/app/_conversation/" }]),
  useParams: () => ({}),
}))
vi.mock("@/lib/workspace", () => ({ useLiveWorkspace: () => live }))
vi.mock("@/lib/api/server", () => server)

const router = vi.hoisted(() => ({
  state: { matches: [] as { routeId: string }[] },
  navigate: vi.fn(),
}))

const server = vi.hoisted(() => ({
  completeReminder: vi.fn(),
  askForChanges: vi.fn(),
}))

const ONBOARDING = "00000000-0000-4000-8000-00000000000a"

let loader: {
  conversations: Conversation[]
  names: Record<string, string>
  active: { id: string; name: string } | null
  activity: []
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
    active: { id: "00000000-0000-4000-8000-000000000001", name: "Fixture" },
    activity: [],
  }
  server.completeReminder.mockReset()
  server.askForChanges.mockReset()
  router.state.matches = []
  router.navigate.mockReset()
  live = { workspace: EMPTY_WORKSPACE, failed: false, refresh: vi.fn() }
  container = document.createElement("div")
  document.body.appendChild(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

/** The panel as the frame mounts it, on Home. */
function Frame() {
  return createElement(WorkspacePanel, { panel: usePanel(live.workspace) })
}

async function render() {
  root = createRoot(container)
  await act(async () => root.render(createElement(Frame)))
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

it("sends an account with no business to name one first", async () => {
  loader.active = null
  await render()
  expect(link("Name your business")?.dataset.to).toBe("/name-your-business")
  expect(link("Start your website")).toBeUndefined()
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

it("says what finished today, and no waiting list when nothing waits", async () => {
  live.workspace = {
    ...EMPTY_WORKSPACE,
    live: 2,
    host: "fixture.example.invalid",
    activity: {
      journey: [],
      now: [],
      waiting: [],
      upcoming: [],
      done: [
        {
          id: "checkin:last",
          kind: "checkin",
          state: "done",
          steps: [{ id: "message", state: "skipped" }],
          at: new Date().toISOString(),
        },
      ],
    },
  }
  await render()
  expect(container.textContent).toContain("Done today")
  expect(container.textContent).toContain(
    "Your assistant checked in, nothing needed you"
  )
  expect(container.textContent).not.toContain("Waiting on you")
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

it("links the live site by name, where the api says it opens, with the host as its title", async () => {
  // Local dev's link: the local router, over http on its port.
  live.workspace = {
    ...EMPTY_WORKSPACE,
    live: 3,
    host: "brightclean-demo.reme.localhost",
    url: "http://brightclean-demo.reme.localhost:3004",
  }
  await render()
  await act(async () => tab("Website")?.click())
  const visit = [...container.querySelectorAll("a")].find((anchor) =>
    anchor.textContent?.startsWith("Visit your website")
  )
  expect(visit?.getAttribute("href")).toBe(
    "http://brightclean-demo.reme.localhost:3004"
  )
  expect(visit?.title).toBe("brightclean-demo.reme.localhost")
  expect(visit?.target).toBe("_blank")
  expect(visit?.rel).toBe("noreferrer")
  expect(container.textContent).toContain("Your website is live")
})

it("Request changes puts the chat's composer into website change mode", async () => {
  live.workspace = {
    ...EMPTY_WORKSPACE,
    live: 3,
    host: "brightclean-demo.example.invalid",
  }
  await render()
  await act(async () => tab("Website")?.click())
  const compose = { mode: "site_change", key: expect.any(String) }

  // From any other page, a new chat.
  await act(async () => buttonNamed("Request changes")?.click())
  expect(router.navigate).toHaveBeenLastCalledWith({
    to: "/app",
    state: { chat: expect.any(String), compose },
  })

  // In a conversation, that one.
  router.state.matches = [{ routeId: "/app/_conversation" }]
  await act(async () => buttonNamed("Request changes")?.click())
  expect(router.navigate).toHaveBeenLastCalledWith({
    to: ".",
    state: { compose },
  })
  expect(container.querySelector("textarea")).toBeNull()
  expect(server.askForChanges).not.toHaveBeenCalled()
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
  await act(async () => root.render(createElement(Frame)))
  expect(tab("Reminders")).toBeUndefined()
  expect(document.activeElement).toBe(tab("Activity"))
  expect(tab("Activity")?.getAttribute("aria-selected")).toBe("true")
})

it("offers a live site's one next step", async () => {
  live.workspace = {
    ...EMPTY_WORKSPACE,
    live: 3,
    host: "fixture.example.invalid",
    url: "https://fixture.example.invalid",
  }
  await render()
  const steps = container.querySelector('[data-slot="next-steps"]')
  expect(
    [...(steps?.querySelectorAll("a, button") ?? [])].map(
      (element) => element.textContent
    )
  ).toEqual(["Visit your website (opens in a new tab)"])
})

it("announces a new line on the same page, and not a build's next stage", async () => {
  const panel = (lead: string, detail: string) =>
    ({ line: { tone: "working", lead, detail } }) as never
  root = createRoot(container)
  const say = async (lead: string, detail: string) =>
    act(async () =>
      root.render(createElement(PanelAnnouncer, { panel: panel(lead, detail) }))
    )
  const status = () => container.querySelector('[role="status"]')?.textContent
  await say("Ellie is building your website", "")
  expect(status()).toBe("")
  await say("Ellie is building your website", "")
  expect(status()).toBe("")
  await say("A new version is ready", "for your review")
  expect(status()).toBe("A new version is ready for your review")
})

it("says once that a quick edit moved to a longer build, and says nothing for any other", async () => {
  const now = new Date().toISOString()
  const ID = "00000000-0000-4000-8000-0000000000b1"
  const build = (extra: Record<string, unknown>) => ({
    ...EMPTY_WORKSPACE,
    live: 1,
    building: true,
    open: true,
    activity: {
      journey: [],
      now: [
        {
          id: `change:${ID}`,
          kind: "change",
          state: "now",
          steps: [{ id: "making", state: "now" }],
          at: now,
        },
      ],
      waiting: [],
      upcoming: [],
      done: [],
    },
    builds: [
      {
        assignment_id: ID,
        kind: "site.revise",
        state: "implementing",
        goal: "Move the FAQ above the steps",
        lane: "full",
        revision: null,
        created_at: now,
        updated_at: now,
        ...extra,
      },
    ],
  })
  const line = () => container.querySelectorAll('[data-slot="fell-through"]')
  live.workspace = build({ fell_through: true }) as Workspace
  await render()
  expect(line()).toHaveLength(1)
  expect(line()[0]?.textContent).toContain("needs more than a quick edit")
  // The change runs as its segment, with its Stop.
  expect(container.querySelector('[data-slot="panel-segment"]')).not.toBeNull()
  expect(container.querySelector('[data-slot="stop-build"]')).not.toBeNull()

  live.workspace = build({}) as Workspace
  await act(async () => root.render(createElement(Frame)))
  expect(line()).toHaveLength(0)
})

it("keeps what the owner did until the state it describes moves on", async () => {
  let say: (text: string) => void = () => undefined
  const Harness = ({ workspace }: { workspace: Workspace }) => {
    const [text, announce] = useAnnouncement(workspace)
    say = announce
    return createElement("p", { role: "status" }, text)
  }
  const at = (over: Partial<Workspace>): Workspace => ({
    ...EMPTY_WORKSPACE,
    ...over,
  })
  root = createRoot(container)
  const show = (workspace: Workspace) =>
    act(async () => root.render(createElement(Harness, { workspace })))
  const status = () => container.querySelector('[role="status"]')?.textContent
  const sent = "Sent. A new version replaces this one."

  await show(at({ live: 1 }))
  await act(async () => say(sent))
  expect(status()).toBe(sent)
  // The read after the write shows the change under way: still said.
  const building = [{ assignment_id: "a", state: "revising" }] as never
  await show(at({ live: 1, builds: building }))
  expect(status()).toBe(sent)
  // The version goes live: the line no longer describes anything.
  await show(at({ live: 2 }))
  expect(status()).toBe("")
})

it("opens the floating pill on the review, else the first question waiting", () => {
  const panel = (over: object) => over as Parameters<typeof firstAsk>[0]
  expect(firstAsk(null)).toBeUndefined()
  expect(firstAsk(panel({ review: null, waiting: [] }))).toBeUndefined()
  expect(
    firstAsk(panel({ review: null, waiting: [{ kind: "question", id: "q" }] }))
  ).toBe("question-q")
  expect(
    firstAsk(
      panel({
        review: { kind: "approval", id: "r" },
        waiting: [{ kind: "question", id: "q" }],
      })
    )
  ).toBe("approval-r")
})
