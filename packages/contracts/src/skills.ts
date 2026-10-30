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

/** `read_skill`'s input: a name from the index in the tool's description. */
export const ReadSkillInput = z.strictObject({ name: SkillName })

/** `read_skill`'s output: the procedure to follow. Refused with `skill.unknown`. */
export const ReadSkillOutput = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("skill"),
    name: SkillName,
    body: Text(4_000),
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
export type ReadSkillInput = z.infer<typeof ReadSkillInput>
export type ReadSkillOutput = z.infer<typeof ReadSkillOutput>
export type SaveCorrectionInput = z.infer<typeof SaveCorrectionInput>
export type SaveCorrectionOutput = z.infer<typeof SaveCorrectionOutput>
export type ScheduleSkillInput = z.infer<typeof ScheduleSkillInput>
export type ScheduleSkillOutput = z.infer<typeof ScheduleSkillOutput>
