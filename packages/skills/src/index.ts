/// <reference path="./markdown.d.ts" />
import type { StaffCorrections } from "@workspace/contracts"
import builds from "../cos/builds/SKILL.md"
import googleConnect from "../cos/google-search/references/connect.md"
import googlePerformance from "../cos/google-search/references/performance.md"
import googleSearch from "../cos/google-search/SKILL.md"
import quoteReply from "../cos/quote-reply/SKILL.md"
import quotesAndPrices from "../cos/quotes-and-prices/SKILL.md"
import remindersAndTime from "../cos/reminders-and-time/SKILL.md"
import reviewReply from "../cos/review-reply/SKILL.md"
import reviews from "../cos/reviews/SKILL.md"
import soul from "../cos/SOUL.md"
import siteChange from "../cos/site-change/SKILL.md"
import boughtElsewhere from "../cos/web-address/references/bought-elsewhere.md"
import buyNew from "../cos/web-address/references/buy-new.md"
import connectOwn from "../cos/web-address/references/connect-own.md"
import tips from "../cos/web-address/references/tips.md"
import webAddress from "../cos/web-address/SKILL.md"
import websiteChanges from "../cos/website-changes/SKILL.md"
import weeklyReview from "../cos/weekly-review/SKILL.md"
import {
  correctionsFor,
  SCHEDULES,
  type Scope,
  type Skill,
} from "./registry.ts"
import { type Part, readSkillFile } from "./skill-file.ts"

export * from "./registry.ts"

export { type Part, readSkillFile, type SkillFile } from "./skill-file.ts"

export type Procedure = Skill & {
  kind: "procedure"
  expertise: string
  status: readonly string[]
  parts: readonly Part[]
}

const cos = (text: string, references?: Record<string, string>): Procedure => {
  const file = readSkillFile(text, references)
  const schedule = SCHEDULES[file.name]
  return {
    ...file,
    ...(schedule && { schedule }),
    scope: "cos",
    kind: "procedure",
  }
}

export const PROCEDURES: readonly Procedure[] = [
  cos(webAddress, {
    "connect-own": connectOwn,
    "buy-new": buyNew,
    "bought-elsewhere": boughtElsewhere,
    tips,
  }),
  cos(googleSearch, { connect: googleConnect, performance: googlePerformance }),
  cos(websiteChanges),
  cos(siteChange),
  cos(builds),
  cos(reviews),
  cos(remindersAndTime),
  cos(quotesAndPrices),
  cos(quoteReply),
  cos(reviewReply),
  cos(weeklyReview),
]

/** The one loader: the procedures for `scope`, then the owner's corrections for it. */
export const skillsFor = (
  scope: Scope,
  corrections: StaffCorrections = { lines: [] }
): Skill[] => [
  ...PROCEDURES.filter((p) => p.scope === scope),
  ...correctionsFor(scope, corrections),
]

/** The index a prompt lists, one `- name (expertise): description` line each. */
export const indexOf = (skills: readonly Skill[]) =>
  skills.map(
    (s) =>
      `- ${s.name}${"expertise" in s ? ` (${s.expertise})` : ""}: ${s.description}`
  )

/**
 * The assistant's identity and character (after Hermes's SOUL.md): the first
 * block of the CoS's core and the onboarding planner's, the same for every
 * business so the cached prefix holds and the owner meets one character.
 */
export const SOUL = soul.trim()

/** A procedure by name, within its scope. */
export const procedure = (scope: Scope, name: string) =>
  PROCEDURES.find((p) => p.scope === scope && p.name === name) ?? null
