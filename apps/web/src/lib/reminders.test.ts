import type { Reminder } from "@workspace/contracts"
import { expect, it } from "vitest"
import type { AttentionItem } from "./api/types"
import { EMPTY_WORKSPACE } from "./attention"
import { dueAtOf, noteOf, reminderRows } from "./reminders"

const APPROVAL = "4d5e6f70-8192-4d8e-af10-4b5c6d7e8f90"
const REQUEST = "5e6f7081-92a3-4e0f-8021-5c6d7e8f9001"
const BUILD = "3c4d5e6f-7081-4c9d-8e0f-1a2b3c4d5e6f"

const approval = {
  kind: "approval",
  id: APPROVAL,
  version: 4,
  request: { assignment_id: BUILD },
} as unknown as AttentionItem
const question = {
  kind: "question",
  id: REQUEST,
  title: "Weekday hours",
  raisedAt: "2026-10-01T09:00:00.000Z",
} as unknown as AttentionItem

it("words each rule for the owner and links it to the item the panel shows", () => {
  const rows = reminderRows(
    {
      ...EMPTY_WORKSPACE,
      attention: [approval, question],
      derivedReminders: [
        {
          rule: "approval_expiring",
          approval_id: APPROVAL,
          version: 4,
          expires_at: "2026-10-04T09:00:00.000Z",
        },
        { rule: "question_waiting", request_id: REQUEST },
        { rule: "preview_unpublished", assignment_id: BUILD, version: 4 },
        { rule: "facts_missing", keys: ["business.email"] },
      ],
    },
    null,
    null
  )
  expect(rows.map(({ text, href }) => ({ text, href }))).toEqual([
    {
      text: "Review version 4 before it closes",
      href: `#approval-${APPROVAL}`,
    },
    {
      text: "Answer the question about weekday hours",
      href: `#question-${REQUEST}`,
    },
    {
      text: "Version 4 is ready but not published",
      href: `#approval-${APPROVAL}`,
    },
    { text: "Tell Reme your email address", href: undefined },
  ])
  // No close time: Coming up shows it, and one time read two ways is worse.
  expect(rows[0]?.detail).toBeUndefined()
})

it("links to nothing the panel does not show", () => {
  const rows = reminderRows(
    {
      ...EMPTY_WORKSPACE,
      derivedReminders: [
        {
          rule: "approval_expiring",
          approval_id: APPROVAL,
          version: 4,
          expires_at: "2026-10-04T09:00:00.000Z",
        },
        { rule: "question_waiting", request_id: REQUEST },
        { rule: "preview_unpublished", assignment_id: BUILD, version: 4 },
      ],
    },
    null,
    null
  )
  expect(rows.map((row) => row.href ?? null)).toEqual([null, null, null])
  expect(rows[1]?.text).toBe("A question is still waiting on you")

  // The build in "Working on" is a target when no approval is.
  const shown = reminderRows(
    {
      ...EMPTY_WORKSPACE,
      derivedReminders: [
        { rule: "preview_unpublished", assignment_id: BUILD, version: 4 },
      ],
    },
    BUILD,
    null
  )
  expect(shown[0]?.href).toBe(`#build-${BUILD}`)

  // A different build in "Working on" is not this one.
  const other = reminderRows(
    {
      ...EMPTY_WORKSPACE,
      derivedReminders: [
        { rule: "preview_unpublished", assignment_id: BUILD, version: 4 },
      ],
    },
    "6f708192-a3b4-4f01-8132-6d7e8f900112",
    null
  )
  expect(other[0]?.href).toBeNull()
})

const note = (over: Partial<Reminder> = {}): Reminder => ({
  id: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d",
  title: "Order more microfibre cloths",
  // 23:30 UTC on 1 July is 00:30 on 2 July in London (summer time).
  due_at: "2026-07-01T23:30:00.000Z",
  done_at: null,
  source: "owner",
  conversation_id: null,
  created_at: "2026-06-30T09:00:00.000Z",
  updated_at: "2026-06-30T09:00:00.000Z",
  ...over,
})

it("shows a due time in the reader's zone, and none before the zone is known", () => {
  expect(noteOf(note(), "Europe/London").due).toBe("2 Jul 2026, 00:30")
  expect(noteOf(note(), "America/New_York").due).toBe("1 Jul 2026, 19:30")
  // The server's render: no time at all, never a UTC one replaced later.
  expect(noteOf(note(), null).due).toBeNull()
  expect(noteOf(note({ due_at: null }), "Europe/London").due).toBeNull()

  // A derived row in the same section reads its time the same way.
  const waiting = (zone: string | null) =>
    reminderRows(
      {
        ...EMPTY_WORKSPACE,
        attention: [
          {
            ...question,
            raisedAt: "2026-07-01T23:30:00.000Z",
          } as AttentionItem,
        ],
        derivedReminders: [{ rule: "question_waiting", request_id: REQUEST }],
      },
      null,
      zone
    )[0]?.detail
  expect(waiting("Europe/London")).toBe(
    "Waiting on you since 2 Jul 2026, 00:30"
  )
  expect(waiting(null)).toBeNull()
})

it("names the Chief of Staff only on its own reminders", () => {
  expect(noteOf(note({ source: "assistant" }), null).byAssistant).toBe(true)
  expect(noteOf(note(), null).byAssistant).toBe(false)
})

it("reads the picker's local time in the browser's zone", () => {
  const zone = process.env.TZ
  process.env.TZ = "Europe/London"
  try {
    expect(dueAtOf("2026-07-02T00:30")).toBe("2026-07-01T23:30:00.000Z")
    expect(dueAtOf("2026-12-02T00:30")).toBe("2026-12-02T00:30:00.000Z")
    expect(dueAtOf("")).toBeNull()
  } finally {
    if (zone === undefined) delete process.env.TZ
    else process.env.TZ = zone
  }
})
