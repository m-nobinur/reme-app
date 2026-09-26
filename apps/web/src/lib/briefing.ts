import type { OrgSummary, Workspace } from "./api/types"

/**
 * What the empty conversation opens with: one line on where things stand, the
 * business and its site on the composer's chip, and up to three things to
 * ask. All of it is read from the workspace, never written by a model, so it
 * costs nothing and says nothing the rows do not.
 */
export type Briefing = {
  line: string | null
  context: { name: string; status: string; live: boolean } | null
  suggestions: { prompt: string }[]
}

const NOTHING: Briefing = { line: null, context: null, suggestions: [] }

export function briefingOf(
  org: OrgSummary | null,
  workspace: Workspace | null
): Briefing {
  if (!org || !workspace) {
    return NOTHING
  }
  const { live, building, open, attention } = workspace
  const approval = attention.find((item) => item.kind === "approval")
  const approvals = attention.filter((item) => item.kind === "approval").length
  const questions = attention.filter((item) => item.kind === "question")

  const site = live
    ? `v${live} is live.`
    : building
      ? "Your first version is being built."
      : open
        ? "Your first version is under way."
        : "You have no website yet."

  let next: string | null = null
  if (approval) {
    next =
      approvals === 1
        ? `Version ${approval.version} is ready for you to approve.`
        : `${approvals} versions are ready for you to approve.`
  } else if (questions.length === 1) {
    next = `${questions[0]?.raisedBy} has one question for you.`
  } else if (questions.length > 1) {
    next = `${questions.length} questions are waiting on you.`
  } else if (building && live) {
    next = "A change is being built."
  }

  const suggestions: string[] = []
  if (approval) {
    suggestions.push(`What changed in version ${approval.version}?`)
  }
  if (questions.length > 0) {
    suggestions.push("What do you need from me?")
  }
  if (building) {
    suggestions.push("How is the build going?")
  }
  if (live) {
    suggestions.push("What is on my website now?")
  } else if (!open && !approval) {
    // Only with no build at all: a paused or waiting one would be superseded.
    suggestions.push("Build my website")
  }

  return {
    line: next ? `${site} ${next}` : site,
    context: {
      name: org.name,
      status: live
        ? `site live on v${live}`
        : building
          ? "first version building"
          : open
            ? "first version under way"
            : "no site yet",
      live: live !== null,
    },
    suggestions: suggestions.slice(0, 3).map((prompt) => ({ prompt })),
  }
}
