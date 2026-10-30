import {
  CORRECTION_MAX,
  CORRECTIONS_MAX,
  type ReadSkillInput,
  type ReadSkillOutput,
  type SaveCorrectionInput,
  type SaveCorrectionOutput,
  type ScheduleSkillInput,
  type ScheduleSkillOutput,
  STAFF_CORRECTIONS_KEY,
} from "@workspace/contracts"
import {
  eq,
  nextFor,
  orgs,
  readCorrections,
  scheduledJobs,
  supersedePrivateFact,
} from "@workspace/db"
import { procedure } from "@workspace/skills"
import { lockProfile, ownerWords, quotedFrom, refusalOf } from "./memory.ts"
import type { ToolContext } from "./tools.ts"
import type { Turn } from "./turns.ts"

const refused = (code: string, message: string) => ({
  outcome: "refused" as const,
  error: { class: "validation" as const, code, message },
})

/** `read_skill`: one of the CoS's procedures, by name. */
export async function readSkill(
  _ctx: ToolContext,
  input: ReadSkillInput
): Promise<ReadSkillOutput> {
  const found = procedure("cos", input.name)
  return found
    ? { outcome: "skill", name: found.name, body: found.body }
    : refused(
        "skill.unknown",
        "No procedure has that name. Use one from read_skill's list."
      )
}

/**
 * The quote gate a correction passes, as a standing request does: one whole
 * sentence the owner typed in this conversation, never a paraphrase.
 */
export const correctionQuoted = (quote: string, said: readonly string[]) =>
  quote.length <= CORRECTION_MAX &&
  refusalOf(quote) !== "attack" &&
  quotedFrom(quote, said)

/**
 * `save_correction`: the owner's sentence about how a staff member works,
 * kept for that staff member's next run. The CoS never reads it back.
 */
export async function saveCorrection(
  { kit, owner }: ToolContext,
  input: SaveCorrectionInput,
  _key: string,
  turn: Turn
): Promise<SaveCorrectionOutput> {
  return kit.withOrg({ orgId: owner.orgId }, async (db) => {
    const text = input.quote.trim().replace(/\s+/g, " ")
    if (!correctionQuoted(text, await ownerWords(db, turn.sessionId))) {
      return refused(
        "correction.not_quoted",
        `A correction quotes one whole sentence the owner typed in this conversation, exactly, ${CORRECTION_MAX} characters at most.`
      )
    }
    await lockProfile(db, owner.orgId, STAFF_CORRECTIONS_KEY)
    const { lines } = await readCorrections(db)
    if (
      lines.some(
        (l) =>
          l.staff === input.staff && l.text.toLowerCase() === text.toLowerCase()
      )
    ) {
      return refused("correction.duplicate", "already saved")
    }
    await supersedePrivateFact(db, {
      orgId: owner.orgId,
      key: STAFF_CORRECTIONS_KEY,
      factType: "owner",
      value: {
        lines: [
          ...lines,
          {
            id: crypto.randomUUID(),
            staff: input.staff,
            text,
            at: new Date().toISOString(),
          },
        ].slice(-CORRECTIONS_MAX),
      },
      provenance: { source: "owner_stated", confidence: 1 },
    })
    return {
      outcome: "saved",
      note: "Saved. It applies from the next build. Do not repeat it.",
    }
  })
}

/**
 * `schedule_skill`: turns a procedure's own schedule on or off, a job the
 * owner asked for in their own words. A job already on is left as it is.
 * The scheduler's hourly scan finds a new one, as it does the heartbeat.
 */
export async function scheduleSkill(
  { kit, owner }: ToolContext,
  input: ScheduleSkillInput
): Promise<ScheduleSkillOutput> {
  const schedule = procedure("cos", input.name)?.schedule
  if (!schedule) {
    return refused(
      "skill.not_scheduled",
      "That procedure has no schedule to turn on or off."
    )
  }
  return kit.withOrg({ orgId: owner.orgId }, async (db) => {
    // Locked, so two calls cannot both insert.
    const [org] = await db
      .select({
        timeZone: orgs.timeZone,
        quietStart: orgs.quietStart,
        quietEnd: orgs.quietEnd,
      })
      .from(orgs)
      .for("update")
    if (!org) throw new Error("skills.org_unreadable")
    const ofKind = eq(scheduledJobs.kind, schedule.kind)
    if (!input.on) {
      await db.delete(scheduledJobs).where(ofKind)
      return { outcome: "off" }
    }
    const [job] = await db
      .select({
        nextRunAt: scheduledJobs.nextRunAt,
        pausedAt: scheduledJobs.pausedAt,
      })
      .from(scheduledJobs)
      .where(ofKind)
    if (job && !job.pausedAt) {
      return { outcome: "on", next_run_at: job.nextRunAt.toISOString() }
    }
    const nextRunAt = nextFor(schedule, org, new Date())
    if (job)
      await db
        .update(scheduledJobs)
        .set({
          rule: schedule.rule,
          nextRunAt,
          claimedAt: null,
          failures: 0,
          pausedAt: null,
        })
        .where(ofKind)
    else
      await db.insert(scheduledJobs).values({
        orgId: owner.orgId,
        kind: schedule.kind,
        rule: schedule.rule,
        nextRunAt,
      })
    return { outcome: "on", next_run_at: nextRunAt.toISOString() }
  })
}
