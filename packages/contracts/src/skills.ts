import { z } from "zod"
import { Timestamp, Uuid } from "./common.ts"
import { Refused } from "./refused.ts"
import { Text } from "./text.ts"

// Skills (architecture §23): a staff member's prompt lists the skills of its
// own scope by name and one line, and the body is read on demand. A
// `procedure` is ours, a file in the repo; a `correction` is the owner's
// whole sentence about how a staff member works, kept per org.

/** Lowercase words joined by hyphens, as the index lists it. */
export const SkillName = z
  .string()
  .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
  .max(64)

/** The staff a correction is for. The CoS keeps its own as `Asked:` lines in the owner profile. */
export const CorrectedStaff = z.enum(["developer"])

/** The corrections' fact key: private, so no business-fact reader sees it. */
export const STAFF_CORRECTIONS_KEY = "staff.corrections"

/** The longest correction: one sentence, as long as a standing request. */
export const CORRECTION_MAX = 160

/** The most corrections an org keeps; the oldest goes first. */
export const CORRECTIONS_MAX = 20

/** `staff.corrections`'s value. `text` is the owner's sentence as typed. */
export const StaffCorrections = z.strictObject({
  lines: z
    .array(
      z.strictObject({
        id: Uuid,
        staff: CorrectedStaff,
        text: Text(CORRECTION_MAX).regex(/^[^\r\n]+$/),
        at: Timestamp,
      })
    )
    .max(CORRECTIONS_MAX),
})

/** The longest skill core or part. */
export const SKILL_BODY_MAX = 10_000

/** The longest line the owner sees while a skill is viewed. */
export const SKILL_STATUS_MAX = 50

/**
 * `read_skill`'s output, which `skill_view` replaced. Kept so a session
 * logged before the rename still parses and replays.
 */
export const ReadSkillOutput = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("skill"),
    name: SkillName,
    body: Text(SKILL_BODY_MAX),
  }),
  Refused,
])

/**
 * `skill_view`'s input. The model is sent `step` as required; a call without
 * one still runs, and the skill's own status line shows instead.
 */
export const SkillViewInput = z.strictObject({
  name: SkillName,
  part: SkillName.optional().describe(
    "A part from the skill's References. Omit it for the core."
  ),
  step: z
    .string()
    .max(SKILL_STATUS_MAX)
    .optional()
    .describe(
      'What the owner sees while you work, sentence case: "Using my SEO skills to check your Google ranking". Vary the opener (Using my, Drawing on my, Utilising my); never repeat your last line.'
    ),
})

/** A skill as `skill_view` returns it, and as code loads one into the history. */
export const ViewedSkill = z.strictObject({
  name: SkillName,
  /** The part viewed; absent for the core. */
  part: SkillName.optional(),
  body: Text(SKILL_BODY_MAX),
  /** The core's parts, by name; the core's References say when to view each. */
  parts: z.array(SkillName).max(10).optional(),
  /** The line the owner saw. */
  status: Text(SKILL_STATUS_MAX),
  /**
   * This business's notes for the skill, "Notes for this business:" then a
   * line each, in the owner's words; absent when it has none. With the core
   * only, so a part never repeats them.
   */
  notes: Text(1_000).optional(),
  /** Set when code loaded it on an explicit trigger, never the model. */
  by: z.literal("code").optional(),
})

/**
 * `skill_view`'s output: the skill, or `unchanged` when this conversation
 * already holds the same text, which shows the owner nothing new. Refused
 * with `skill.unknown` or `skill.no_part`, naming the valid ones.
 */
export const SkillViewOutput = z.discriminatedUnion("outcome", [
  ViewedSkill.extend({ outcome: z.literal("skill") }),
  z.strictObject({
    outcome: z.literal("unchanged"),
    name: SkillName,
    part: SkillName.optional(),
    note: Text(200),
  }),
  Refused,
])

/**
 * `save_correction`'s input: how the owner told a staff member to work, as
 * one whole sentence they typed in this conversation.
 */
export const SaveCorrectionInput = z.strictObject({
  staff: CorrectedStaff,
  quote: Text(CORRECTION_MAX).describe(
    "The owner's whole sentence, exactly as they typed it."
  ),
})

/** `save_correction`'s output. Refused with `correction.not_quoted` or `correction.duplicate`. */
export const SaveCorrectionOutput = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("saved"), note: Text(200) }),
  Refused,
])

/** `schedule_skill`'s input: turn a procedure's own schedule on or off. */
export const ScheduleSkillInput = z.strictObject({
  name: SkillName,
  on: z.boolean(),
})

/** `schedule_skill`'s output. Refused with `skill.not_scheduled`. */
export const ScheduleSkillOutput = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("on"), next_run_at: Timestamp }),
  z.strictObject({ outcome: z.literal("off") }),
  Refused,
])

export type SkillName = z.infer<typeof SkillName>
export type CorrectedStaff = z.infer<typeof CorrectedStaff>
export type StaffCorrections = z.infer<typeof StaffCorrections>
export type ReadSkillOutput = z.infer<typeof ReadSkillOutput>
export type SkillViewInput = z.infer<typeof SkillViewInput>
export type SkillViewOutput = z.infer<typeof SkillViewOutput>
export type ViewedSkill = z.infer<typeof ViewedSkill>
export type SaveCorrectionInput = z.infer<typeof SaveCorrectionInput>
export type SaveCorrectionOutput = z.infer<typeof SaveCorrectionOutput>
export type ScheduleSkillInput = z.infer<typeof ScheduleSkillInput>
export type ScheduleSkillOutput = z.infer<typeof ScheduleSkillOutput>
