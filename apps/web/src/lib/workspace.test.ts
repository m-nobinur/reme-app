import type { BuildSummary } from "@workspace/contracts"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { Workspace, WorkspacePoll } from "./api/types"
import { EMPTY_WORKSPACE } from "./attention"
import { INTERVAL, type Poller, startPolling } from "./workspace"

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
  await wait(INTERVAL.building)
  expect(tags).toHaveLength(2)
  expect(changes.at(-1)).toEqual({ workspace: idle, failed: false })
  await wait(INTERVAL.building * 3)
  expect(tags).toHaveLength(2)
  await wait(INTERVAL.idle)
  expect(tags).toHaveLength(3)
  // The new tag is the one sent.
  expect(tags.at(-1)).toBe('"idle"')
})

it("keeps what it has on a 304", async () => {
  start(building)
  answers = ["unchanged", "unchanged"]
  await wait(INTERVAL.building * 2)
  expect(tags).toHaveLength(2)
  expect(changes).toEqual([])
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
  // Recovered: back to the build's pace.
  await wait(INTERVAL.building)
  expect(tags).toHaveLength(3)
})

it("stops on a hidden tab and reads at once when it comes back", async () => {
  start(building)
  page.flip(true)
  await wait(INTERVAL.idle * 4)
  expect(tags).toEqual([])
  page.flip(false)
  await wait(0)
  expect(tags).toHaveLength(1)
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

it("counts polls and 304s per build", async () => {
  start(building)
  answers = ["unchanged", "unchanged", idle]
  await wait(INTERVAL.building * 3)
  await wait(INTERVAL.idle)
  expect(poller.stats).toEqual({
    [BUILD.assignment_id]: { polls: 3, unchanged: 2, failed: 0 },
    idle: { polls: 1, unchanged: 1, failed: 0 },
  })
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

it("counts polls against the build that is running, not the newest", async () => {
  const queued: BuildSummary = {
    ...BUILD,
    assignment_id: "00000000-0000-4000-8000-000000000009",
    state: "queued",
  }
  start({ ...building, builds: [queued, BUILD] })
  await wait(INTERVAL.building)
  expect(Object.keys(poller.stats)).toEqual([BUILD.assignment_id])
})
