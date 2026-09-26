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
