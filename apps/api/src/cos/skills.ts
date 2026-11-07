import {
  CORRECTION_MAX,
  CORRECTIONS_MAX,
  type SaveCorrectionInput,
  type SaveCorrectionOutput,
  type ScheduleSkillInput,
  type ScheduleSkillOutput,
  SKILL_STATUS_MAX,
  type SkillTrigger,
  type SkillViewInput,
  SkillViewOutput,
  STAFF_CORRECTIONS_KEY,
  type ViewedSkill,
} from "@workspace/contracts"
import {
  eq,
  nextFor,
  type OrgScopedDb,
  orgs,
  readCorrections,
  scheduledJobs,
  supersedePrivateFact,
} from "@workspace/db"
import { PROCEDURES, type Procedure, procedure } from "@workspace/skills"
import type { ModelMessage } from "ai"
import { thoughtLine } from "../thinking.ts"
import {
  lockProfile,
  ownerWords,
  quotedFrom,
  refusalOf,
  skillNotesText,
} from "./memory.ts"
import type { ToolContext } from "./tools.ts"
import type { Turn } from "./turns.ts"

const refused = (code: string, message: string) => ({
  outcome: "refused" as const,
  error: { class: "validation" as const, code, message },
})

/** The skills this conversation already holds, as the model was sent them, oldest first. */
export const viewedIn = (messages: readonly ModelMessage[]): ViewedSkill[] =>
  messages.flatMap((m) =>
    m.role === "tool"
      ? m.content.flatMap((p) => {
          if (p.type !== "tool-result" || p.toolName !== "skill_view") return []
          const read = SkillViewOutput.safeParse(
            p.output.type === "json" ? p.output.value : null
          )
          return read.success && read.data.outcome === "skill"
            ? [read.data]
            : []
        })
      : []
  )

/**
 * The line the owner sees for a view: the model's `step` when it reads as
 * a status line, else one of the skill's own, never the line shown last.
 */
export function statusOf(
  skill: Pick<Procedure, "status">,
  step: string | undefined,
  last: string | undefined
): string {
  const line = thoughtLine(step ?? "")
  if (
    line &&
    line.length <= SKILL_STATUS_MAX &&
    line !== last &&
    !/know-how/i.test(line)
  )
    return line
  return skill.status.find((s) => s !== last) ?? (skill.status[0] as string)
}

/**
 * The skill, or its part, as a view returns it, with the line to show. The
 * core carries this business's notes for the skill, so they load only with
 * it and a part never repeats them.
 */
export function viewOf(
  skill: Procedure,
  part: string | undefined,
  status: string,
  notes?: string
): ViewedSkill | null {
  if (!part) {
    return {
      name: skill.name,
      body: skill.body,
      ...(skill.parts.length > 0 && { parts: skill.parts.map((p) => p.name) }),
      status,
      ...(notes && { notes }),
    }
  }
  const found = skill.parts.find((p) => p.name === part)
  return found ? { name: skill.name, part, body: found.body, status } : null
}

/**
 * One line per skill a turn views or code loads, for the turn logs: which,
 * by whom, on what trigger and the line the owner saw.
 */
export const logView = (
  turn: Turn,
  view: { name: string; part?: string | undefined },
  by: "model" | "code",
  outcome: "skill" | "unchanged" | "refused",
  status: string | null,
  trigger: SkillTrigger | null = null
) =>
  console.log(
    JSON.stringify({
      code: "cos.skill_view",
      turn_id: turn.turnId,
      session_id: turn.sessionId,
      name: view.name,
      part: view.part ?? null,
      by,
      trigger,
      outcome,
      status,
    })
  )

/**
 * `skill_view`: one of the CoS's skills, or a part of one, by name. A view
 * of text this conversation already holds unchanged returns a short note,
 * as Hermes's dedup does; compaction or pruning drops the earlier result, so
 * the next view returns the text again.
 */
export async function skillView(
  ctx: ToolContext,
  input: SkillViewInput,
  _key: string,
  turn: Turn,
  _zone: string | null,
  messages: readonly ModelMessage[]
): Promise<SkillViewOutput> {
  const skill = procedure("cos", input.name)
  if (!skill) {
    logView(turn, input, "model", "refused", null)
    return refused(
      "skill.unknown",
      `No skill has that name. The skills are ${PROCEDURES.map((p) => p.name).join(", ")}.`
    )
  }
  const held = viewedIn(messages)
  const view = viewOf(
    skill,
    input.part,
    statusOf(skill, input.step, held.at(-1)?.status),
    input.part
      ? undefined
      : await ctx.kit.withOrg({ orgId: ctx.owner.orgId }, (db) =>
          skillNotesText(db, skill.name)
        )
  )
  if (!view) {
    logView(turn, input, "model", "refused", null)
    return refused(
      "skill.no_part",
      skill.parts.length > 0
        ? `${skill.name} has no part by that name. Its parts are ${skill.parts.map((p) => p.name).join(", ")}.`
        : `${skill.name} has no parts: its core is the whole skill.`
    )
  }
  if (
    held.some(
      (h) =>
        h.name === view.name &&
        h.part === view.part &&
        h.body === view.body &&
        h.notes === view.notes
    )
  ) {
    logView(turn, input, "model", "unchanged", null)
    return {
      outcome: "unchanged",
      name: view.name,
      ...(view.part && { part: view.part }),
      note: "Already in this conversation, unchanged: follow it.",
    }
  }
  logView(turn, input, "model", "skill", view.status)
  return { outcome: "skill", ...view }
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
    if (!(await addCorrection(db, owner.orgId, input.staff, text))) {
      return refused("correction.duplicate", "already saved")
    }
    return {
      outcome: "saved",
      note: "Saved. It applies from the next build. Do not repeat it.",
    }
  })
}

/** One quoted correction added under the corrections' lock; false when it is saved already. */
export async function addCorrection(
  db: OrgScopedDb,
  orgId: string,
  staff: SaveCorrectionInput["staff"],
  text: string
): Promise<boolean> {
  await lockProfile(db, orgId, STAFF_CORRECTIONS_KEY)
  const { lines } = await readCorrections(db)
  if (
    lines.some(
      (l) => l.staff === staff && l.text.toLowerCase() === text.toLowerCase()
    )
  ) {
    return false
  }
  await supersedePrivateFact(db, {
    orgId,
    key: STAFF_CORRECTIONS_KEY,
    factType: "owner",
    value: {
      lines: [
        ...lines,
        { id: crypto.randomUUID(), staff, text, at: new Date().toISOString() },
      ].slice(-CORRECTIONS_MAX),
    },
    provenance: { source: "owner_stated", confidence: 1 },
  })
  return true
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
      "That skill has no schedule to turn on or off."
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
