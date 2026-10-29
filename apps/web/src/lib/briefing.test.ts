import { expect, it } from "vitest"
import type { AttentionItem, Workspace } from "./api/types"
import { EMPTY_WORKSPACE } from "./attention"
import { briefingOf } from "./briefing"

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
  const nothing = { line: null, suggestions: [] }
  expect(briefingOf(null, workspace())).toEqual(nothing)
  expect(briefingOf(ORG, null)).toEqual(nothing)
})

it("offers the first build to an owner with no site", () => {
  const briefing = briefingOf(ORG, workspace())
  expect(briefing.line).toBe("You don't have a website yet.")
  expect(prompts(briefing)).toEqual([
    "Build my website",
    "Let me tell you about my business",
  ])
})

it("asks a new business for the facts the assistant still needs, after the build", () => {
  const briefing = briefingOf(
    ORG,
    workspace({
      derivedReminders: [
        {
          rule: "facts_missing",
          keys: ["business.phone", "hours.weekday"],
        },
      ],
    })
  )
  expect(prompts(briefing)).toEqual([
    "Build my website",
    "Add my phone number and weekday hours",
    "Let me tell you about my business",
  ])
})

it("does not list every missing fact in one suggestion", () => {
  const briefing = briefingOf(
    ORG,
    workspace({
      derivedReminders: [
        {
          rule: "facts_missing",
          keys: ["business.phone", "business.email", "hours.weekday"],
        },
      ],
    })
  )
  expect(prompts(briefing)).toContain("Add my business details")
})

it("offers a live site's owner a look, a change and a reminder", () => {
  expect(prompts(briefingOf(ORG, workspace({ live: 3 })))).toEqual([
    "What's on my website now?",
    "I want to change something on my website",
    "Set a reminder for me",
  ])
})

it("says the assistant asks, never who on the staff did", () => {
  const briefing = briefingOf(
    ORG,
    workspace({ live: 3, attention: [question("The Developer")] })
  )
  expect(briefing.line).toBe(
    "Your website is live. Your assistant has a question for you."
  )
  expect(
    briefingOf(
      ORG,
      workspace({
        live: 3,
        assistantName: "Ellie",
        attention: [question("The Developer")],
      })
    ).line
  ).toBe("Your website is live. Ellie has a question for you.")
  expect(prompts(briefing)).toEqual([
    "What do you need from me?",
    "What's on my website now?",
    "I want to change something on my website",
    "Set a reminder for me",
  ])
})

it("counts questions when there is more than one", () => {
  const briefing = briefingOf(
    ORG,
    workspace({ live: 2, attention: [question("A"), question("B")] })
  )
  expect(briefing.line).toBe(
    "Your website is live. You have 2 questions to answer."
  )
})

it("puts an approval before a question, and keeps to four suggestions", () => {
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
    "Your website is live. Your latest changes are ready to publish."
  )
  expect(prompts(briefing)).toEqual([
    "What did you change?",
    "What do you need from me?",
    "How are my changes coming along?",
    "What's on my website now?",
  ])
})

it("calls a first site with versions waiting ready to go live", () => {
  const briefing = briefingOf(
    ORG,
    workspace({ open: true, attention: [approval(1), approval(2)] })
  )
  expect(briefing.line).toBe("Your website is ready to go live.")
  expect(prompts(briefing)).toEqual(["What's on my new website?"])
})

it("says a first build is the website, and a later one is changes", () => {
  const first = briefingOf(ORG, workspace({ building: true, open: true }))
  expect(first.line).toBe("Your assistant is building your website.")
  expect(prompts(first)).toEqual(["How's my website coming along?"])

  const later = briefingOf(
    ORG,
    workspace({ live: 5, building: true, open: true })
  )
  expect(later.line).toBe(
    "Your website is live. Your assistant is working on your changes."
  )
})

it("never offers a build while a first one is open but not working", () => {
  // Paused, waiting on an answer or ready for review: a build exists, so the
  // owner has a site on the way, and "Build my website" would start another.
  const briefing = briefingOf(ORG, workspace({ open: true }))
  expect(briefing.line).toBe("Your website is in progress.")
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
    "Your website is live. Publish your latest changes by tomorrow at 9:00 AM."
  )
  expect(line(at(1, 15))).toBe(
    "Your website is live. Publish your latest changes by today at 3:00 PM."
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
      "Your website is ready to go live. Publish it by tomorrow at 12:30 AM."
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
    "Your website is live. Your assistant is still waiting for your answer about weekday hours."
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
    "Your website is live. Your latest changes aren't published yet."
  )
  expect(prompts(briefing)[0]).toBe("Why aren't my changes live yet?")
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
    "Your website is live. Your latest changes are ready to publish."
  )
  expect(lineOf({ attention: [question("The Developer")] })).toBe(
    "Your website is live. Your assistant has a question for you."
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
  ).toMatch(/^Your website is live\. Publish your latest changes by today at /)
})

it("lists the facts the assistant still needs, after anything waiting on the owner", () => {
  const facts = [
    {
      rule: "facts_missing" as const,
      keys: ["business.phone" as const, "hours.weekday" as const],
    },
  ]
  expect(
    briefingOf(ORG, workspace({ derivedReminders: facts }), NOW).line
  ).toBe(
    "You don't have a website yet. Your assistant still needs your phone number and weekday hours."
  )
  expect(
    briefingOf(
      ORG,
      workspace({ live: 2, attention: [approval(3)], derivedReminders: facts }),
      NOW
    ).line
  ).toBe("Your website is live. Your latest changes are ready to publish.")
})
