import type { BuildSummary } from "@workspace/contracts"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { Workspace, WorkspacePoll } from "./api/types"
import { EMPTY_WORKSPACE } from "./attention"
import {
  afterFrameRead,
  BUILDING_BACKOFF,
  INTERVAL,
  JUST_READY_MS,
  type Poller,
  READ_LIMIT_MS,
  startPolling,
} from "./workspace"

const BUILD: BuildSummary = {
  assignment_id: "00000000-0000-4000-8000-000000000003",
  kind: "site.build",
  state: "implementing",
  goal: "Build my website",
  revision: null,
  created_at: "2026-09-26T10:00:00.000Z",
  updated_at: "2026-09-26T10:00:00.000Z",
}

const idle: Workspace = { ...EMPTY_WORKSPACE, etag: '"idle"' }
const building: Workspace = {
  ...EMPTY_WORKSPACE,
  building: true,
  open: true,
  builds: [BUILD],
  etag: '"building"',
}

/** A tab whose visibility the test flips. */
function tab() {
  const listeners = new Set<() => void>()
  return {
    hidden: false,
    addEventListener: (_: string, listener: () => void) => {
      listeners.add(listener)
    },
    removeEventListener: (_: string, listener: () => void) => {
      listeners.delete(listener)
    },
    flip(hidden: boolean) {
      this.hidden = hidden
      for (const listener of listeners) listener()
    },
    focus() {
      for (const listener of listeners) listener()
    },
  }
}

let page: ReturnType<typeof tab>
let answers: (WorkspacePoll | Error)[]
let tags: (string | null)[]
let changes: { workspace: Workspace | null; failed: boolean }[]
let poller: Poller

const read = async (etag: string | null) => {
  tags.push(etag)
  const next = answers.shift() ?? "unchanged"
  if (next instanceof Error) throw next
  return next
}

function start(initial: Workspace | null) {
  poller = startPolling({
    initial,
    read,
    onChange: (workspace, failed) => changes.push({ workspace, failed }),
    page,
  })
}

/** Runs the clock forward and lets the read it started settle. */
async function wait(ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers()
  page = tab()
  answers = []
  tags = []
  changes = []
})

afterEach(() => {
  poller.stop()
  vi.useRealTimers()
})

it("polls every 30 s with nothing building, sending the last tag", async () => {
  start(idle)
  await wait(INTERVAL.idle - 1)
  expect(tags).toEqual([])
  await wait(1)
  expect(tags).toEqual(['"idle"'])
  await wait(INTERVAL.idle)
  expect(tags).toEqual(['"idle"', '"idle"'])
})

it("polls every 3 s while a build runs, and slows when it stops", async () => {
  start(building)
  await wait(INTERVAL.building)
  expect(tags).toHaveLength(1)
  answers = [idle]
  await wait(BUILDING_BACKOFF[1])
  expect(tags).toHaveLength(2)
  expect(changes.at(-1)).toEqual({ workspace: idle, failed: false })
  await wait(INTERVAL.building * 3)
  expect(tags).toHaveLength(2)
  await wait(INTERVAL.idle)
  expect(tags).toHaveLength(3)
  // The new tag is the one sent.
  expect(tags.at(-1)).toBe('"idle"')
})

it("polls every 3 s while a build waits in the queue", async () => {
  start({
    ...EMPTY_WORKSPACE,
    open: true,
    builds: [{ ...BUILD, state: "queued" }],
    etag: '"queued"',
  })
  await wait(INTERVAL.building)
  expect(tags).toEqual(['"queued"'])
})

it("keeps what it has on a 304", async () => {
  start(building)
  answers = ["unchanged", "unchanged"]
  await wait(INTERVAL.building + BUILDING_BACKOFF[1])
  expect(tags).toHaveLength(2)
  expect(changes).toEqual([])
})

it("eases from 3 s to 4 s on unchanged reads and holds at 4 s", async () => {
  start(building)
  for (const step of [3_000, 3_000, 4_000, 4_000, 4_000]) {
    const before = tags.length
    await wait(step - 1)
    expect(tags).toHaveLength(before)
    await wait(1)
    expect(tags).toHaveLength(before + 1)
  }
})

it("snaps back to 3 s on a change, a focus and an owner action", async () => {
  start(building)
  await wait(3_000 + 3_000) // two unchanged reads: the next is 4 s away
  answers = [{ ...building, etag: '"moved"' }]
  await wait(4_000)
  expect(changes).toHaveLength(1)
  let n = tags.length
  await wait(INTERVAL.building)
  expect(tags).toHaveLength(n + 1)
  await wait(3_000) // unchanged again: the next is 4 s away
  page.focus()
  await wait(0)
  n = tags.length
  await wait(INTERVAL.building)
  expect(tags).toHaveLength(n + 1)
  await wait(3_000)
  void poller.refresh()
  await wait(0)
  n = tags.length
  await wait(INTERVAL.building)
  expect(tags).toHaveLength(n + 1)
})

it("backs off to 60 s after a failed read, and keeps the last workspace", async () => {
  start(building)
  answers = [new Error("503")]
  await wait(INTERVAL.building)
  expect(changes).toEqual([{ workspace: building, failed: true }])
  await wait(INTERVAL.error - 1)
  expect(tags).toHaveLength(1)
  await wait(1)
  expect(tags).toHaveLength(2)
  // Recovered: the first unchanged read leaves the next one 3 s away.
  await wait(BUILDING_BACKOFF[1])
  expect(tags).toHaveLength(3)
})

it("clears the failure on the first good read, even an unchanged one", async () => {
  start(building)
  answers = [new Error("503"), "unchanged"]
  await wait(INTERVAL.building + INTERVAL.error)
  expect(changes).toEqual([
    { workspace: building, failed: true },
    { workspace: building, failed: false },
  ])
})

it("keeps a build's pace while a built draft takes its screenshots", async () => {
  start({ ...idle, builds: [{ ...BUILD, state: "preview_ready" }] })
  await wait(INTERVAL.building)
  expect(tags).toHaveLength(1)
})

it("keeps a build's pace for a minute after a review opens, then idles", async () => {
  const review = {
    ...idle,
    attention: [
      { kind: "approval", raisedAt: new Date(Date.now()).toISOString() },
    ],
  } as unknown as Workspace
  start(review)
  await wait(INTERVAL.building)
  expect(tags).toHaveLength(1)
  await wait(JUST_READY_MS)
  const n = tags.length
  await wait(INTERVAL.building * 2)
  expect(tags).toHaveLength(n)
})

it("stops on a hidden idle tab and reads at once when it comes back", async () => {
  start(idle)
  page.flip(true)
  await wait(INTERVAL.idle * 4)
  expect(tags).toEqual([])
  page.flip(false)
  await wait(0)
  expect(tags).toHaveLength(1)
})

it("keeps its pace on a hidden tab while a build is in flight", async () => {
  start(building)
  page.flip(true)
  await wait(3_000 + 3_000 + 4_000)
  expect(tags).toHaveLength(3)
})

it("reads at once when the tab gains focus", async () => {
  start(idle)
  page.focus()
  await wait(0)
  expect(tags).toHaveLength(1)
})

it("does not let a read that never answers hold up the ones behind it", async () => {
  let calls = 0
  poller.stop()
  poller = startPolling({
    initial: building,
    read: () => {
      calls++
      return calls === 1
        ? new Promise<WorkspacePoll>(() => undefined)
        : Promise.resolve(idle)
    },
    onChange: (workspace, failed) => changes.push({ workspace, failed }),
    page,
  })
  await wait(INTERVAL.building)
  expect(calls).toBe(1)
  await wait(READ_LIMIT_MS)
  expect(changes).toEqual([{ workspace: building, failed: true }])
  await wait(INTERVAL.error)
  expect(changes.at(-1)).toEqual({ workspace: idle, failed: false })
})

it("reads at once on refresh, after an owner action or a chat turn", async () => {
  start(idle)
  answers = [building]
  await poller.refresh()
  expect(tags).toEqual(['"idle"'])
  expect(changes).toEqual([{ workspace: building, failed: false }])
  // And the schedule restarts from the refresh, at the new pace.
  await wait(INTERVAL.building)
  expect(tags).toHaveLength(2)
})

it("reads again when a refresh lands while a poll is under way", async () => {
  start(idle)
  let release: (value: WorkspacePoll) => void = () => undefined
  const slow = new Promise<WorkspacePoll>((resolve) => {
    release = resolve
  })
  const reads: (string | null)[] = []
  poller.stop()
  poller = startPolling({
    initial: idle,
    read: (etag) => {
      reads.push(etag)
      return reads.length === 1 ? slow : Promise.resolve("unchanged")
    },
    onChange: () => undefined,
    page,
  })
  const first = poller.refresh()
  const second = poller.refresh()
  release("unchanged")
  await first
  await second
  await wait(0)
  // The poll that was already under way began before the action, so its
  // answer is not trusted as the answer to the refresh.
  expect(reads).toHaveLength(2)
})

it("answers a refresh made during a poll only once a later read lands", async () => {
  const releases: ((value: WorkspacePoll) => void)[] = []
  poller.stop()
  poller = startPolling({
    initial: idle,
    read: () =>
      new Promise<WorkspacePoll>((resolve) => {
        releases.push(resolve)
      }),
    onChange: () => undefined,
    page,
  })
  // The poll is out when the owner's write lands and asks for a read.
  void poller.refresh()
  let answered = false
  void poller.refresh().then(() => {
    answered = true
  })
  releases[0]?.("unchanged")
  await wait(0)
  // The older poll has landed; its answer predates the write.
  expect(releases).toHaveLength(2)
  expect(answered).toBe(false)
  releases[1]?.(building)
  await wait(0)
  expect(answered).toBe(true)
})

it("adopts a workspace a loader read, and polls at its pace", async () => {
  start(idle)
  poller.adopt(building)
  await wait(INTERVAL.building)
  expect(tags).toEqual(['"building"'])
})

it("ignores a poll that was under way when a newer read was adopted", async () => {
  let release: (value: WorkspacePoll) => void = () => undefined
  poller = startPolling({
    initial: idle,
    read: () =>
      new Promise<WorkspacePoll>((resolve) => {
        release = resolve
      }),
    onChange: (workspace, failed) => changes.push({ workspace, failed }),
    page,
  })
  const stale = poller.refresh()
  poller.adopt(building)
  release({ ...idle, etag: '"older"' })
  await stale
  expect(changes).toEqual([])
  // The adopted read sets the pace: a build is running.
  answers = []
  await wait(0)
})

it("keeps the workspace on screen when the frame's read fails", () => {
  expect(afterFrameRead(building, null)).toEqual({
    workspace: building,
    failed: true,
  })
  expect(afterFrameRead(idle, building)).toEqual({
    workspace: building,
    failed: false,
  })
})
