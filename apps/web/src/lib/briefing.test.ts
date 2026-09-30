import { expect, it } from "vitest"
import type { AttentionItem, Workspace } from "./api/types"
import { EMPTY_WORKSPACE } from "./attention"
import { briefingOf, digestOf } from "./briefing"

const ORG = { id: "org_a", slug: "fixture-clean", name: "Fixture Clean" }

const question = (raisedBy: string) =>
  ({ kind: "question", id: raisedBy, raisedBy }) as unknown as AttentionItem
const approval = (version: number) =>
  ({ kind: "approval", id: `v${version}`, version }) as unknown as AttentionItem

const workspace = (over: Partial<Workspace> = {}): Workspace => ({
  ...EMPTY_WORKSPACE,
  ...over,
})

const prompts = (value: ReturnType<typeof briefingOf>) =>
  value.suggestions.map((suggestion) => suggestion.prompt)

it("says nothing without an organisation or a workspace to read", () => {
  const nothing = { line: null, context: null, suggestions: [] }
  expect(briefingOf(null, workspace())).toEqual(nothing)
  expect(briefingOf(ORG, null)).toEqual(nothing)
})

it("offers the first build to an owner with no site", () => {
  const briefing = briefingOf(ORG, workspace())
  expect(briefing.line).toBe("You have no website yet.")
  expect(briefing.context).toEqual({
    name: "Fixture Clean",
    status: "no site yet",
    live: false,
  })
  expect(prompts(briefing)).toEqual(["Build my website"])
})

it("names who asked when one question waits on a live site", () => {
  const briefing = briefingOf(
    ORG,
    workspace({ live: 3, attention: [question("The Developer")] })
  )
  expect(briefing.line).toBe(
    "v3 is live. The Developer has one question for you."
  )
  expect(briefing.context).toEqual({
    name: "Fixture Clean",
    status: "site live on v3",
    live: true,
  })
  expect(prompts(briefing)).toEqual([
    "What do you need from me?",
    "What is on my website now?",
  ])
})

it("counts questions when there is more than one", () => {
  const briefing = briefingOf(
    ORG,
    workspace({ live: 2, attention: [question("A"), question("B")] })
  )
  expect(briefing.line).toBe("v2 is live. 2 questions are waiting on you.")
})

it("puts an approval before a question, and keeps to three suggestions", () => {
  const briefing = briefingOf(
    ORG,
    workspace({
      live: 3,
      building: true,
      open: true,
      attention: [approval(4), question("The Developer")],
    })
  )
  expect(briefing.line).toBe(
    "v3 is live. Version 4 is ready for you to approve."
  )
  expect(prompts(briefing)).toEqual([
    "What changed in version 4?",
    "What do you need from me?",
    "How is the build going?",
  ])
})

it("counts approvals when there is more than one", () => {
  const briefing = briefingOf(
    ORG,
    workspace({ open: true, attention: [approval(1), approval(2)] })
  )
  expect(briefing.line).toBe(
    "Your first version is under way. 2 versions are ready for you to approve."
  )
  expect(prompts(briefing)).toEqual(["What changed in version 1?"])
})

it("says a first build is under way, and a later one is a change", () => {
  const first = briefingOf(ORG, workspace({ building: true, open: true }))
  expect(first.line).toBe("Your first version is being built.")
  expect(first.context?.status).toBe("first version building")
  expect(prompts(first)).toEqual(["How is the build going?"])

  const later = briefingOf(
    ORG,
    workspace({ live: 5, building: true, open: true })
  )
  expect(later.line).toBe("v5 is live. A change is being built.")
})

it("never offers a build while a first one is open but not working", () => {
  // Paused, waiting on an answer or ready for review: a build exists, so the
  // owner has a site on the way, and "Build my website" would start another.
  const briefing = briefingOf(ORG, workspace({ open: true }))
  expect(briefing.line).toBe("Your first version is under way.")
  expect(briefing.context?.status).toBe("first version under way")
  expect(prompts(briefing)).not.toContain("Build my website")
})

/* Derived reminders ---------------------------------------------------- */

// Built from local parts, so each case is about the browser's own calendar.
const NOW = new Date(2026, 9, 1, 10, 0)
const at = (day: number, hour: number) =>
  new Date(2026, 9, day, hour, 0).toISOString()
const APPROVAL = "4d5e6f70-8192-4d8e-af10-4b5c6d7e8f90"
const REQUEST = "5e6f7081-92a3-4e0f-8021-5c6d7e8f9001"

it("names the day and time a review closes, in the browser's time zone", () => {
  const line = (expires: string) =>
    briefingOf(
      ORG,
      workspace({
        live: 3,
        attention: [approval(4)],
        derivedReminders: [
          {
            rule: "approval_expiring",
            approval_id: APPROVAL,
            version: 4,
            expires_at: expires,
          },
        ],
      }),
      NOW
    ).line
  expect(line(at(2, 9))).toBe(
    "v3 is live. Your review of v4 expires tomorrow at 09:00."
  )
  expect(line(at(1, 15))).toBe(
    "v3 is live. Your review of v4 expires today at 15:00."
  )
})

it("reads the review's local day even where UTC is on another", () => {
  // 23:30 in London on 1 October is 22:30 UTC. A review closing at 00:30
  // London time closes tomorrow for the owner and today in UTC.
  const zone = process.env.TZ
  process.env.TZ = "Europe/London"
  try {
    const briefing = briefingOf(
      ORG,
      workspace({
        attention: [approval(2)],
        open: true,
        derivedReminders: [
          {
            rule: "approval_expiring",
            approval_id: APPROVAL,
            version: 2,
            expires_at: "2026-10-01T23:30:00.000Z",
          },
        ],
      }),
      new Date("2026-10-01T22:30:00.000Z")
    )
    expect(briefing.line).toBe(
      "Your first version is under way. Your review of v2 expires tomorrow at 00:30."
    )
  } finally {
    process.env.TZ = zone
  }
})

it("nudges about a question that has waited, naming it, in place of the count", () => {
  const waiting = {
    ...question("The Developer"),
    id: REQUEST,
    title: "Weekday hours",
  } as AttentionItem
  const briefing = briefingOf(
    ORG,
    workspace({
      live: 3,
      attention: [question("A"), waiting],
      derivedReminders: [{ rule: "question_waiting", request_id: REQUEST }],
    }),
    NOW
  )
  expect(briefing.line).toBe(
    "v3 is live. The Developer's question about weekday hours is still waiting on you."
  )
})

it("says a finished version was never published", () => {
  const briefing = briefingOf(
    ORG,
    workspace({
      live: 3,
      derivedReminders: [
        {
          rule: "preview_unpublished",
          assignment_id: "3c4d5e6f-7081-4c9d-8e0f-1a2b3c4d5e6f",
          version: 4,
        },
      ],
    }),
    NOW
  )
  expect(briefing.line).toBe(
    "v3 is live. Version 4 is ready but not published."
  )
})

it("puts an unpublished version after reviews and questions", () => {
  const unpublished = {
    rule: "preview_unpublished" as const,
    assignment_id: "3c4d5e6f-7081-4c9d-8e0f-1a2b3c4d5e6f",
    version: 4,
  }
  const lineOf = (over: Partial<Workspace>) =>
    briefingOf(
      ORG,
      workspace({
        live: 3,
        ...over,
        derivedReminders: [unpublished, ...(over.derivedReminders ?? [])],
      }),
      NOW
    ).line
  expect(lineOf({ attention: [approval(5)] })).toBe(
    "v3 is live. Version 5 is ready for you to approve."
  )
  expect(lineOf({ attention: [question("The Developer")] })).toBe(
    "v3 is live. The Developer has one question for you."
  )
  expect(
    lineOf({
      attention: [approval(5)],
      derivedReminders: [
        {
          rule: "approval_expiring",
          approval_id: "v5",
          version: 5,
          expires_at: NOW.toISOString(),
        },
      ],
    })
  ).toMatch(/^v3 is live\. Your review of v5 expires today at /)
})

it("lists the facts Reme still needs, after anything waiting on the owner", () => {
  const facts = [
    {
      rule: "facts_missing" as const,
      keys: ["business.phone" as const, "hours.weekday" as const],
    },
  ]
  expect(
    briefingOf(ORG, workspace({ derivedReminders: facts }), NOW).line
  ).toBe(
    "You have no website yet. Reme still needs your phone number and weekday hours."
  )
  expect(
    briefingOf(
      ORG,
      workspace({ live: 2, attention: [approval(3)], derivedReminders: facts }),
      NOW
    ).line
  ).toBe("v2 is live. Version 3 is ready for you to approve.")
})

const names = { "staff-sam": "Sam" }
const reminder = (title: string, due: string | null) =>
  ({
    id: title,
    title,
    due_at: due,
  }) as unknown as Workspace["reminderNotes"][number]

it("tells an owner with nothing waiting that they are caught up", () => {
  expect(digestOf(workspace({ live: 4 }), names, NOW)).toEqual([
    "You're all caught up. Nothing needs you right now.",
    "Your website is live on version 4.",
    "Ask Reme in the chat to change something on your website, or to set a reminder.",
  ])
  expect(
    digestOf(workspace({ building: true, open: true }), names, NOW)
  ).toEqual([
    "You're all caught up. Nothing needs you right now.",
    "Reme is building your first website now.",
  ])
})

it("leads with today's reminders, then reviews and questions, three at most", () => {
  const asked = {
    ...question("Reme"),
    raisedById: "staff-sam",
    title: "Weekday hours",
  } as AttentionItem
  expect(
    digestOf(
      workspace({
        live: 4,
        attention: [approval(5), asked],
        reminderNotes: [
          reminder("Call the supplier", at(1, 15)),
          reminder("Order more cloths", at(2, 9)),
        ],
      }),
      names,
      NOW
    )
  ).toEqual([
    "You have a reminder today at 15:00: Call the supplier.",
    "Version 5 of your website is ready for you to review below.",
    "Sam asked about weekday hours. Answer it below.",
  ])
  expect(
    digestOf(
      workspace({
        live: 4,
        attention: [approval(5), approval(6), question("A"), question("B")],
        reminderNotes: [
          reminder("Call the supplier", at(1, 15)),
          reminder("Order more cloths?", at(1, 17)),
        ],
      }),
      names,
      NOW
    )
  ).toEqual([
    "You have 2 reminders today. The next is at 15:00: Call the supplier.",
    "2 versions of your website are ready for you to review below.",
    "Your team has 2 questions for you below.",
  ])
})

it("names missing facts only when no question asks for them", () => {
  const facts = [
    { rule: "facts_missing" as const, keys: ["business.phone" as const] },
  ]
  expect(
    digestOf(workspace({ open: true, derivedReminders: facts }), names, NOW)
  ).toEqual([
    "Reme still needs your phone number.",
    "Your first website is under way.",
  ])
  expect(
    digestOf(
      workspace({
        live: 2,
        attention: [
          { ...question("Sam"), title: "Phone number" } as AttentionItem,
        ],
        derivedReminders: facts,
      }),
      names,
      NOW
    )[1]
  ).toBe("Your website is live on version 2.")
})

it("says nothing about today before the browser's clock is known", () => {
  const later = workspace({
    live: 4,
    reminderNotes: [reminder("Call the supplier", "2099-10-01T15:00:00.000Z")],
  })
  // The reminder could be today, so the server claims neither way.
  expect(digestOf(later, names, null)).toEqual([
    "Your website is live on version 4.",
  ])
  expect(
    digestOf(workspace({ attention: [approval(2)], open: true }), names, null)
  ).toEqual([
    "Version 2 of your website is ready for you to review below.",
    "Your first website is under way.",
  ])
})
