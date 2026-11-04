import type {
  CorrectedStaff,
  JobKind,
  StaffCorrections,
} from "@workspace/contracts"

// The half of the skills that imports no skill file, for the orchestrator:
// flue's Vite plugin packages any `SKILL.md` import as its own skill object,
// so the bundled text stays behind `@workspace/skills`, which only the api reads.

/** Whose prompt a skill is for: the CoS, or a staff role. */
export type Scope = "cos" | CorrectedStaff

/**
 * One entry the loader returns (architecture §23). A `procedure` is ours and
 * the same for every org, a SKILL.md under `cos/`; a `correction` is the
 * owner's sentence, per org.
 */
export type Skill = {
  name: string
  /** One line, at most 90 characters, which the index shows: when to view it. */
  description: string
  scope: Scope
  kind: "procedure" | "correction"
  body: string
  /** The job kind that runs it and its cron rule, read in the org's zone. */
  schedule?: { kind: JobKind; rule: string }
}

/** The skills a job runs on its own, by name, with the job kind and its cron rule. */
export const SCHEDULES: Readonly<
  Record<string, { kind: JobKind; rule: string }>
> = {
  "weekly-review": { kind: "weekly_report", rule: "0 8 * * 1" },
}

/** The skill a scheduled job kind runs, by name. */
export function scheduledBy(kind: JobKind) {
  const found = Object.entries(SCHEDULES).find(([, s]) => s.kind === kind)
  return found ? { name: found[0], schedule: found[1] } : null
}

/**
 * The owner's corrections for `scope`, as `readCorrections` reads them.
 * Corrections are per org, so a prompt shared across orgs is built with none.
 */
export const correctionsFor = (
  scope: Scope,
  corrections: StaffCorrections = { lines: [] }
): Skill[] =>
  corrections.lines
    .filter((l) => l.staff === scope)
    .map((l, i) => ({
      name: `correction-${i + 1}`,
      description: l.text.slice(0, 60),
      scope,
      kind: "correction" as const,
      body: l.text,
    }))
