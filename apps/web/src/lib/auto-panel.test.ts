import type { ActivitySegment } from "@workspace/contracts"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { AttentionItem, Workspace } from "./api/types"
import { EMPTY_WORKSPACE } from "./attention"
import {
  type AutoPanel,
  autoPanel,
  FOLD_AFTER_MS,
  REOPEN_AFTER_MS,
} from "./auto-panel"

const segment = (id: string, state: ActivitySegment["state"]) =>
  ({
    id,
    kind: "website",
    state,
    steps: [],
    at: "2026-10-01T09:00:00.000Z",
  }) as ActivitySegment

const question = { kind: "question", id: "question-1" } as AttentionItem

/** A workspace with these segments at work or waiting, and these items waiting. */
const read = (
  now: ActivitySegment[] = [],
  attention: AttentionItem[] = [],
  waiting: ActivitySegment[] = []
): Workspace => ({
  ...EMPTY_WORKSPACE,
  attention,
  activity: { journey: [], now, waiting, upcoming: [], done: [] },
})

let sent: boolean[]
let panel: AutoPanel

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
  panel = autoPanel((open) => sent.push(open))
})

afterEach(() => {
  panel.stop()
  vi.useRealTimers()
})

it("sets what is already there on the first read and opens nothing", () => {
  panel.watch(read([segment("website", "now")], [question]))
  expect(sent).toEqual([])
})

it("opens when a job starts, and again only for the next new one", () => {
  panel.watch(read())
  panel.watch(read([segment("website", "now")]))
  expect(sent).toEqual([true])
  // The same job on the next poll is not news.
  panel.watch(read([segment("website", "now")]))
  expect(sent).toEqual([true])
  panel.watch(read([segment("website", "now"), segment("domain", "now")]))
  expect(sent).toEqual([true, true])
})

it("opens when a question or a blocked job starts to wait on the owner", () => {
  panel.watch(read())
  panel.watch(read([], [question]))
  panel.watch(read([], [question], [segment("domain", "waiting")]))
  expect(sent).toEqual([true, true])
})

it("folds five seconds after the work is over, across several reads", () => {
  panel.watch(read())
  panel.watch(read([segment("website", "now")]))
  panel.watch(read())
  vi.advanceTimersByTime(FOLD_AFTER_MS - 1000)
  // Polls land every few seconds and must not restart the wait.
  panel.watch(read())
  vi.advanceTimersByTime(999)
  expect(sent).toEqual([true])
  vi.advanceTimersByTime(1)
  expect(sent).toEqual([true, false])
})

it("does not fold while something waits on the owner, then folds once it is answered", () => {
  panel.watch(read())
  panel.watch(read([segment("website", "now")], [question]))
  panel.watch(read([], [question]))
  vi.advanceTimersByTime(FOLD_AFTER_MS * 3)
  expect(sent).toEqual([true])
  panel.watch(read())
  vi.advanceTimersByTime(FOLD_AFTER_MS)
  expect(sent).toEqual([true, false])
})

it("does not fold when new work starts inside the wait", () => {
  panel.watch(read())
  panel.watch(read([segment("website", "now")]))
  panel.watch(read())
  vi.advanceTimersByTime(FOLD_AFTER_MS - 1)
  panel.watch(read([segment("change", "now")]))
  vi.advanceTimersByTime(FOLD_AFTER_MS * 3)
  expect(sent).toEqual([true, true])
})

it("stays shut for a minute after the owner closed it, then opens", () => {
  panel.watch(read())
  panel.toggled(false)
  vi.advanceTimersByTime(REOPEN_AFTER_MS - 1)
  panel.watch(read([segment("website", "now")]))
  expect(sent).toEqual([])
  vi.advanceTimersByTime(1)
  panel.watch(read([segment("website", "now"), segment("domain", "now")]))
  expect(sent).toEqual([true])
})

it("never folds a panel the owner touched", () => {
  panel.watch(read())
  panel.watch(read([segment("website", "now")]))
  panel.toggled(true)
  panel.watch(read())
  vi.advanceTimersByTime(FOLD_AFTER_MS * 3)
  expect(sent).toEqual([true])
})

it("never folds a panel it opened while setup is open", () => {
  const setup = (now: ActivitySegment[] = []): Workspace => ({
    ...read(now),
    activity: {
      journey: [{ ...segment("onboarding", "upcoming"), kind: "onboarding" }],
      now,
      waiting: [],
      upcoming: [],
      done: [],
    },
  })
  panel.watch(setup())
  panel.watch(setup([segment("website", "now")]))
  panel.watch(setup())
  vi.advanceTimersByTime(FOLD_AFTER_MS)
  expect(sent).toEqual([true])
})
