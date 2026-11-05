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
  WorkspacePanelLine,
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
    select([{ routeId: route.id }]),
  useParams: () => ({}),
}))
vi.mock("@/lib/workspace", () => ({
  useLiveWorkspace: () => live,
}))
vi.mock("@workspace/ui/lib/zone", async (actual) => ({
  ...(await actual<typeof import("@workspace/ui/lib/zone")>()),
  browserZone: () => "Europe/London",
}))
vi.mock("@/lib/api/server", () => server)

const route = vi.hoisted(() => ({ id: "/app/_conversation/" }))

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
  route.id = "/app/_conversation/"
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

it('sends "Finish setting up" to the onboarding conversation', async () => {
  loader.conversations = [
    {
      id: ONBOARDING,
      kind: "onboarding",
      archived_at: null,
    } as unknown as Conversation,
  ]
  await render()
  const next = link("Finish setting up")
  expect(next?.dataset.to).toBe("/app/c/$id")
  expect(JSON.parse(next?.dataset.params ?? "null")).toEqual({
    id: ONBOARDING,
  })
})

it("sends an account with no business to name one first", async () => {
  loader.active = null
  route.id = "/app/_conversation/c/$id"
  await render()
  expect(link("Name your business")?.dataset.to).toBe("/name-your-business")
  expect(link("Start your website")).toBeUndefined()
})

it("offers no naming link at home, where the naming form already is", async () => {
  loader.active = null
  await render()
  expect(link("Name your business")).toBeUndefined()
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

it("says what finished folded to its heading, and no Now list when nothing waits", async () => {
  const checkin = (message: "done" | "skipped") => ({
    id: "checkin:last",
    kind: "checkin" as const,
    state: "done" as const,
    steps: [{ id: "message", state: message }],
    at: new Date().toISOString(),
  })
  const activity = (done: ReturnType<typeof checkin>[]) => ({
    journey: [],
    now: [],
    waiting: [],
    upcoming: [],
    done,
  })
  live.workspace = {
    ...EMPTY_WORKSPACE,
    live: 2,
    host: "fixture.example.invalid",
    activity: activity([checkin("done")]),
  }
  await render()
  const completed = section("Completed")
  const heading = completed?.querySelector("h2 button")
  expect(heading?.getAttribute("aria-expanded")).toBe("false")
  expect(completed?.querySelector("[hidden]")?.textContent).toContain(
    "Your assistant checked in and left you a message"
  )
  await act(async () => (heading as HTMLButtonElement).click())
  expect(heading?.getAttribute("aria-expanded")).toBe("true")
  expect(completed?.querySelector("[hidden]")).toBeNull()
  expect(container.textContent).not.toContain("Now")
  await act(async () => root.unmount())

  // A check-in that found nothing is no row, only one quiet line.
  live.workspace = {
    ...live.workspace,
    activity: activity([checkin("skipped")]),
  }
  await render()
  expect(section("Completed")).toBeUndefined()
  expect(container.textContent).toMatch(
    /Last check-in \d+:\d+ [AP]M, all clear/
  )
})

it("shows a time in the reader's zone, not the business's", async () => {
  live.workspace = {
    ...EMPTY_WORKSPACE,
    live: 2,
    host: "fixture.example.invalid",
    timeZone: "Asia/Dhaka",
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
          at: "2026-10-31T14:00:00.000Z",
        },
      ],
    },
  }
  await render()
  // London is UTC+0 on 31 October; Dhaka would say 8:00 PM.
  expect(container.textContent).toContain("2:00 PM")
  expect(container.textContent).not.toContain("8:00 PM")
})

const section = (title: string) =>
  [...container.querySelectorAll("section")].find((each) =>
    each.querySelector("h2")?.textContent?.startsWith(title)
  )

it("puts a job waiting on the owner first under Now, with no group of its own", async () => {
  live.workspace = {
    ...EMPTY_WORKSPACE,
    activity: {
      journey: [
        {
          id: "golive",
          kind: "golive",
          state: "waiting",
          steps: [{ id: "approval", state: "waiting" }],
          at: new Date().toISOString(),
        },
      ],
      now: [],
      waiting: [],
      upcoming: [],
      done: [],
    },
  }
  await render()
  // The header already says what waits, so no heading says it again.
  expect(section("Now")?.textContent).toContain("Going live")
  expect(section("Waiting on you")).toBeUndefined()
})

it("offers to connect a web address, as a message into the open or latest chat", async () => {
  live.workspace = {
    ...EMPTY_WORKSPACE,
    live: 2,
    host: "fixture.example.invalid",
    activity: {
      journey: [],
      now: [],
      waiting: [],
      upcoming: [
        {
          id: "address:1",
          kind: "address",
          state: "upcoming",
          steps: [{ id: "find_out", state: "next" }],
          at: new Date().toISOString(),
        },
      ],
      done: [],
    },
  }
  const ask = "Help me set up my domain"
  const sent = () => router.navigate.mock.lastCall?.[0]
  const RECENT = "00000000-0000-4000-8000-00000000000d"
  loader.conversations = [
    {
      id: ONBOARDING,
      archived_at: null,
      updated_at: "2026-09-26T10:00:00.000Z",
    } as unknown as Conversation,
    {
      id: RECENT,
      archived_at: null,
      updated_at: "2026-09-27T10:00:00.000Z",
    } as unknown as Conversation,
  ]
  router.state.matches = [{ routeId: "/app/_conversation" }]
  await render()
  expect(container.textContent).toContain("Domain · Not connected")
  expect(section("Up next")).toBeUndefined()
  expect(section("Coming up")).toBeUndefined()
  // In a conversation, into that conversation.
  await act(async () => buttonNamed("Connect now")?.click())
  expect(sent()).toEqual({
    to: ".",
    state: {
      send: { text: ask, key: expect.any(String), intent: "connect_address" },
    },
  })
  // From any other page, into the most recent one.
  router.state.matches = []
  await act(async () => buttonNamed("Connect now")?.click())
  expect(sent()).toEqual({
    to: "/app/c/$id",
    params: { id: RECENT },
    state: {
      send: { text: ask, key: expect.any(String), intent: "connect_address" },
    },
  })
  // With none, a new chat opens with it.
  loader.conversations = []
  await act(async () => root.render(createElement(Frame)))
  await act(async () => buttonNamed("Connect now")?.click())
  expect(sent()).toEqual({
    to: "/app",
    state: { chat: expect.any(String), ask, intent: "connect_address" },
  })
  // The Website tab offers it too.
  const tab = [...container.querySelectorAll('[role="tab"]')].find(
    (each) => each.textContent === "Website"
  )
  await act(async () => (tab as HTMLElement).click())
  expect(
    container.querySelector('[data-slot="your-website"]')?.textContent
  ).toContain("Domain · Not connected")
})

it("asks whether a name bought elsewhere is bought, each answer said in the chat", async () => {
  const name = "sparkleclean.co.uk"
  live.workspace = {
    ...EMPTY_WORKSPACE,
    journey: {
      website: "draft_ready",
      address: { stage: "buying_elsewhere", name, offer: "connect" },
      google: "waiting_for_domain",
    },
    activity: {
      journey: [],
      now: [],
      waiting: [
        {
          id: "address:1",
          kind: "address",
          state: "waiting",
          steps: [{ id: "purchase", state: "waiting", note: `buying ${name}` }],
          at: new Date().toISOString(),
          names: { domain: name },
        },
      ],
      upcoming: [],
      done: [],
    },
  }
  router.state.matches = [{ routeId: "/app/_conversation" }]
  await render()
  const said = (text: string) => ({
    to: ".",
    state: {
      send: { text, key: expect.any(String), intent: "connect_address" },
    },
  })
  await act(async () => buttonNamed("I bought it")?.click())
  expect(router.navigate.mock.lastCall?.[0]).toEqual(
    said(`I've bought ${name}`)
  )
  await act(async () => buttonNamed("Not yet")?.click())
  expect(router.navigate.mock.lastCall?.[0]).toEqual(
    said(`I haven't bought ${name} yet`)
  )
})

it("draws no tab bar for one tab", async () => {
  await render()
  expect(container.querySelector('[role="tablist"]')).toBeNull()
})

it("shows a part that finishes on screen ticked in Now, then moves it to Completed", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  const steps = (contact: "now" | "done") =>
    ["work", "area", "customers", "proof", "quote_form"]
      .map((id) => ({ id, state: "done" as const }))
      .concat([
        { id: "contact", state: contact },
        { id: "assistant", state: contact === "done" ? "now" : "next" },
      ] as never[])
  const onboarding = (contact: "now" | "done") => ({
    ...EMPTY_WORKSPACE,
    activity: {
      journey: [
        {
          id: "onboarding",
          kind: "onboarding" as const,
          state: "now" as const,
          steps: steps(contact),
          at: new Date().toISOString(),
        },
      ],
      now: [],
      waiting: [],
      upcoming: [],
      done: [],
    },
  })
  try {
    live.workspace = onboarding("now")
    await render()
    expect(section("Now")?.textContent).toContain("About the business")
    live.workspace = onboarding("done")
    await act(async () => root.render(createElement(Frame)))
    // Its tick in Now, and not twice: Completed waits for it.
    expect(section("Now")?.textContent).toContain("Business details saved")
    expect(section("Now")?.textContent).toContain("Your assistant")
    expect(section("Completed")).toBeUndefined()
    await act(async () => vi.advanceTimersByTime(3000))
    expect(section("Now")?.textContent).not.toContain("Business details saved")
    expect(section("Completed")?.textContent).toContain(
      "Business details saved"
    )
  } finally {
    vi.useRealTimers()
  }
})

/** Setting up at the design tray, with the logo round the api read, if any. */
const atTheTray = (logo?: {
  status: "drawing" | "ready"
  options: number
}) => ({
  ...EMPTY_WORKSPACE,
  activity: {
    journey: [
      {
        id: "onboarding",
        kind: "onboarding" as const,
        state: "waiting" as const,
        steps: [
          "work",
          "area",
          "customers",
          "proof",
          "quote_form",
          "contact",
          "assistant",
          "website",
        ]
          .map((id) => ({ id, state: "done" as const }))
          .concat([{ id: "look", state: "waiting" }] as never[]),
        at: new Date().toISOString(),
        ...(logo ? { logo } : {}),
      },
    ],
    now: [],
    waiting: [],
    upcoming: [],
    done: [],
  },
})

const glowing = () =>
  [
    ...container.querySelectorAll<HTMLElement>(
      '[data-slot="panel-segment"][data-fresh]'
    ),
  ].map((row) => row.querySelector("h3")?.textContent)

it("glows a row that opens while the panel is up, once, and none that was there", async () => {
  live.workspace = atTheTray()
  await render()
  expect(glowing()).toEqual([])
  live.workspace = atTheTray({ status: "drawing", options: 3 })
  await act(async () => root.render(createElement(Frame)))
  expect(glowing()).toEqual(["Your logo · Designing 3 options"])
  const row = container.querySelector('[data-fresh="true"]')
  expect(row?.className).toContain("motion-safe:before:animate-row-glow")
  // The next read moves the same row on: no second row glows, and the one
  // that did keeps its class, so the animation does not start again.
  live.workspace = atTheTray({ status: "ready", options: 3 })
  await act(async () => root.render(createElement(Frame)))
  expect(glowing()).toEqual(["Your logo · Waiting for your pick"])
  expect(container.querySelector('[data-fresh="true"]')).toBe(row)
})

it("glows no row with less motion", async () => {
  const media = vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query.includes("reduce"),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList
  )
  try {
    live.workspace = atTheTray()
    await render()
    live.workspace = atTheTray({ status: "drawing", options: 3 })
    await act(async () => root.render(createElement(Frame)))
    expect(section("Now")?.textContent).toContain("Your logo")
    expect(glowing()).toEqual([])
  } finally {
    media.mockRestore()
  }
})

it("gives the phone's panel button its status in place of the halo, and the desktop none", async () => {
  const line = {
    tone: "working" as const,
    lead: "Reme is building your website",
  }
  const shown = async (
    badge: Parameters<typeof WorkspacePanelLine>[0]["panel"]
  ) => {
    root = createRoot(container)
    await act(async () =>
      root.render(
        createElement(WorkspacePanelLine, { panel: badge, avatar: null })
      )
    )
    const chip = container.querySelector('[data-slot="live-line-badge"]')
    const text = chip?.textContent ?? null
    const phoneOnly = chip?.className.includes("md:hidden") ?? null
    await act(async () => root.unmount())
    return { text, phoneOnly }
  }
  const panel = (badge: unknown) =>
    ({ line, badge }) as Parameters<typeof WorkspacePanelLine>[0]["panel"]
  expect(await shown(panel({ kind: "working", minutes: 6 }))).toEqual({
    text: "6 min left",
    phoneOnly: true,
  })
  expect(await shown(panel({ kind: "answer", count: 1 }))).toEqual({
    text: "1 waiting on you",
    phoneOnly: true,
  })
  expect(await shown(panel(null))).toEqual({ text: null, phoneOnly: null })
  root = createRoot(container)
  await act(async () =>
    root.render(
      createElement(WorkspacePanelLine, { panel: panel(null), avatar: null })
    )
  )
  // The halo is the desktop's alone.
  expect(
    container.querySelector('[data-slot="live-line-halo"]')?.className
  ).toContain("max-md:hidden")
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
  expect(container.textContent).toContain(
    "Live at brightclean-demo.reme.localhost"
  )
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
    "That didn't go through. Try again."
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

it("leaves the visit link to the Website tab, not Activity", async () => {
  live.workspace = {
    ...EMPTY_WORKSPACE,
    live: 3,
    host: "fixture.example.invalid",
    url: "https://fixture.example.invalid",
  }
  await render()
  expect(container.querySelector('[data-slot="next-steps"]')).toBeNull()
  expect(container.textContent).not.toContain("Visit your website")
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
  await say("Reme is building your website", "")
  expect(status()).toBe("")
  await say("Reme is building your website", "")
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

  // A quick edit checking its pages after its preview can still be stopped;
  // a full build with its preview made has nothing left to stop.
  const stop = () =>
    [...container.querySelectorAll('[data-slot="stop-build"] button')].some(
      (b) => b.textContent === "Stop"
    )
  live.workspace = build({ lane: "quick", state: "preview_ready" }) as Workspace
  await act(async () => root.render(createElement(Frame)))
  expect(stop()).toBe(true)
  live.workspace = build({ state: "preview_ready" }) as Workspace
  await act(async () => root.render(createElement(Frame)))
  expect(stop()).toBe(false)

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
