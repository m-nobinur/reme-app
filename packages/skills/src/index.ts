import type {
  CorrectedStaff,
  JobKind,
  StaffCorrections,
} from "@workspace/contracts"
import { quoteReply } from "./procedures/quote-reply.ts"
import { reviewReply } from "./procedures/review-reply.ts"
import { weeklyReview } from "./procedures/weekly-review.ts"

/** Whose prompt a skill is for: the CoS, or a staff role. */
export type Scope = "cos" | CorrectedStaff

/**
 * One entry the loader returns (architecture §23). A `procedure` is ours and
 * the same for every org; a `correction` is the owner's sentence, per org.
 */
export type Skill = {
  name: string
  /** One line, at most 60 characters, which the index shows. */
  description: string
  scope: Scope
  kind: "procedure" | "correction"
  body: string
  /** The job kind that runs it and its cron rule, read in the org's zone. */
  schedule?: { kind: JobKind; rule: string }
}

export type Procedure = Skill & { kind: "procedure" }

export const PROCEDURES: readonly Procedure[] = [
  weeklyReview,
  reviewReply,
  quoteReply,
]

/**
 * The one loader: the procedures for `scope`, then the owner's corrections
 * for it, as `readCorrections` reads them. Corrections are per org, so a
 * prompt shared across orgs is built with none.
 */
export function skillsFor(
  scope: Scope,
  corrections: StaffCorrections = { lines: [] }
): Skill[] {
  return [
    ...PROCEDURES.filter((p) => p.scope === scope),
    ...corrections.lines
      .filter((l) => l.staff === scope)
      .map((l, i) => ({
        name: `correction-${i + 1}`,
        description: l.text.slice(0, 60),
        scope,
        kind: "correction" as const,
        body: l.text,
      })),
  ]
}

/** The index a prompt lists, one `name: description` line each. */
export const indexOf = (skills: readonly Skill[]) =>
  skills.map((s) => `${s.name}: ${s.description}`)

/** A procedure by name, within its scope. */
export const procedure = (scope: Scope, name: string) =>
  PROCEDURES.find((p) => p.scope === scope && p.name === name) ?? null

/** The procedure a scheduled job kind runs. */
export const scheduledBy = (kind: JobKind) =>
  PROCEDURES.find((p) => p.schedule?.kind === kind) ?? null
