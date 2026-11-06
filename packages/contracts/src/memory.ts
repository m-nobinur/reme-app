import { z } from "zod"
import { Timestamp, Uuid } from "./common.ts"
import { BUSINESS_ADDRESS_KEY } from "./domain.ts"
import { Refused } from "./refused.ts"
import { SkillName, STAFF_CORRECTIONS_KEY, StaffCorrections } from "./skills.ts"
import { TIPS_KEY } from "./task.ts"
import { Text } from "./text.ts"

// What the Chief of Staff remembers about the owner (ADR-042): one fact of
// plain lines, versioned like any fact, so each change can be undone.

/** The profile's fact key. The profile is data about the person, not the business. */
export const OWNER_PROFILE_KEY = "owner.profile"

/**
 * The CoS's working notes (plan §6, after Hermes's MEMORY.md): how this
 * business runs day to day where the facts hold nothing, such as where the
 * keys are kept, in the owner's words. Private like the profile.
 */
export const WORKING_NOTES_KEY = "assistant.working_notes"

/**
 * The notes each business keeps for one skill (after Hermes routing a task's
 * preferences to its skill): how this owner wants that kind of work done.
 * The skills are shared by every business, so the notes live here, per org,
 * and load only with their skill.
 */
export const SKILL_NOTES_KEY = "assistant.skill_notes"

/** The owner's "Ask me before saving" choice, the changes reflection proposed, and how far the chat has shown the profile's changes. */
export const OWNER_MEMORY_REVIEW_KEY = "owner.memory_review"

/**
 * Facts that belong to the Chief of Staff's memory of the owner, the owner's
 * corrections for staff, and the business address Your details keeps. Every
 * reader of the business's facts leaves them out: they never reach a builder
 * snapshot, `get_facts`, the website or the claims gate (§8.5). The
 * corrections reach their staff member through the skills loader alone.
 */
export const PRIVATE_FACT_KEYS: readonly string[] = [
  OWNER_PROFILE_KEY,
  WORKING_NOTES_KEY,
  OWNER_MEMORY_REVIEW_KEY,
  SKILL_NOTES_KEY,
  BUSINESS_ADDRESS_KEY,
  STAFF_CORRECTIONS_KEY,
  TIPS_KEY,
]

/** The most the profile may hold, counted on its rendered text. */
export const PROFILE_MAX_CHARS = 1_600
export const PROFILE_LINE_MAX = 300
/** The most the working notes may hold, counted the same way. */
export const NOTES_MAX_CHARS = 3_500
/** The most one skill's notes may hold for one business, counted the same way. */
export const SKILL_NOTES_MAX_CHARS = 800

/**
 * The most lines `chars` characters can hold: one character each and the
 * newline between them. A line cap set to it never binds before the
 * character budget does.
 */
export const linesWithin = (chars: number) => Math.floor((chars + 1) / 2)

/** How a line came to be there. Only `owner_said` is protected from reflection. */
export const ProfileSource = z.enum([
  "owner_said",
  "owner_confirmed",
  "reflection",
])

export const ProfileLine = z.strictObject({
  id: Uuid,
  text: Text(PROFILE_LINE_MAX).regex(/^[^\r\n]+$/),
  source: ProfileSource,
  at: Timestamp,
})

/** The text the model reads and the limit counts: one line each. */
export const profileText = (lines: readonly { text: string }[]) =>
  lines.map((l) => l.text).join("\n")

/** `owner.profile`'s value. */
export const OwnerProfile = z
  .strictObject({
    lines: z.array(ProfileLine).max(linesWithin(PROFILE_MAX_CHARS)),
  })
  .refine((p) => profileText(p.lines).length <= PROFILE_MAX_CHARS, {
    message: `The profile holds at most ${PROFILE_MAX_CHARS} characters.`,
  })

/** `assistant.working_notes`'s value: the profile's shape with its own budget. */
export const WorkingNotes = z
  .strictObject({
    lines: z.array(ProfileLine).max(linesWithin(NOTES_MAX_CHARS)),
  })
  .refine((p) => profileText(p.lines).length <= NOTES_MAX_CHARS, {
    message: `The working notes hold at most ${NOTES_MAX_CHARS} characters.`,
  })

/** One line of a skill's notes for this business. */
export const SkillNoteLine = ProfileLine.extend({ skill: SkillName })

/**
 * `assistant.skill_notes`'s value: every skill's notes, each within its own
 * budget. No line cap of its own: each skill's budget bounds its lines, and
 * only a skill that exists can be written.
 */
export const SkillNotes = z
  .strictObject({ lines: z.array(SkillNoteLine) })
  .refine(
    (p) =>
      [...new Set(p.lines.map((l) => l.skill))].every(
        (skill) =>
          profileText(p.lines.filter((l) => l.skill === skill)).length <=
          SKILL_NOTES_MAX_CHARS
      ),
    {
      message: `Each skill's notes hold at most ${SKILL_NOTES_MAX_CHARS} characters.`,
    }
  )

/**
 * A store's value read line by line without its budget, so a store over a
 * limit since lowered still reads and a write can take lines out of it.
 */
export const StoreLines = z.strictObject({
  lines: z.array(z.union([SkillNoteLine, ProfileLine])),
})

/**
 * Where a `memory` write goes: `user`, the owner profile; `notes`, the
 * working notes; `skill:<name>`, that skill's notes for this business.
 */
export const MemoryTarget = z
  .string()
  .regex(/^(user|notes|skill:[a-z][a-z0-9]*(-[a-z0-9]+)*)$/)
  .describe("user, notes or skill:<name>")

/**
 * A change reflection wants to make while "Ask me before saving" is on. It
 * waits on the owner's page: accepting it saves it as `owner_confirmed`.
 * `was` is the whole line a replace, patch or remove would touch.
 */
export const MemoryProposal = z.strictObject({
  id: Uuid,
  /** `patch` is the `memory` tool's; `replace` stays for proposals stored before it. */
  action: z.enum(["add", "replace", "patch", "remove"]),
  /** The store it changes; absent on proposals stored before notes and skill notes, which were the profile's. */
  target: MemoryTarget.optional(),
  text: Text(PROFILE_LINE_MAX).optional(),
  was: Text(PROFILE_LINE_MAX).optional(),
  at: Timestamp,
})

/**
 * `owner.memory_review`'s value. `chip_through` is the newest profile
 * version the chat has already shown, so a change is shown once.
 */
export const OwnerMemoryReview = z.strictObject({
  ask_first: z.boolean(),
  proposals: z.array(MemoryProposal).max(10),
  chip_through: z.int().nonnegative(),
})

/**
 * One change to the profile. `match` is a short piece of an existing line
 * that only one line holds. Which fields each action needs is checked where
 * the change is applied: a refine here would be invisible to the JSON Schema
 * the model is sent, and a union nested in a tool's input is not safe on
 * every provider.
 */
export const RememberOperation = z.strictObject({
  action: z.enum(["add", "replace", "remove"]),
  text: Text(PROFILE_LINE_MAX)
    .optional()
    .describe(
      "The line, as a plain statement about the owner. Required for add and replace."
    ),
  match: Text(80)
    .optional()
    .describe(
      "A short piece of the existing line that no other line holds. Required for replace and remove."
    ),
})

/** `remember`'s input, which `memory` replaced. Kept so a session logged before the rename still parses. */
export const RememberInput = z.strictObject({
  operations: z.array(RememberOperation).min(1).max(8),
  store: z
    .enum(["profile", "notes"])
    .optional()
    .describe(
      "profile, the default: about the owner. notes: how this business runs day to day where the facts hold nothing."
    ),
})

/** `remember`'s output, kept with its input for sessions logged before `memory`. */
export const RememberOutput = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("saved"),
    note: Text(200),
    fullness: Text(60),
  }),
  z.strictObject({
    outcome: z.literal("full"),
    note: Text(200),
    fullness: Text(60),
    lines: z.array(Text(PROFILE_LINE_MAX)).max(40),
  }),
  z.strictObject({ outcome: z.literal("stopped"), note: Text(200) }),
  Refused,
])

/**
 * One change in a `memory` batch, after Hermes's memory tool: `add` a new
 * entry; `patch` the span `old_text` of the one entry holding it into
 * `content`, the rest of the entry kept; `remove` the one entry holding
 * `old_text`. Which fields each action needs is checked where the batch is
 * applied, as with `RememberOperation`.
 */
export const MemoryOperation = z.strictObject({
  action: z.enum(["add", "patch", "remove"]),
  content: Text(PROFILE_LINE_MAX)
    .optional()
    .describe("add: the new entry. patch: what old_text becomes."),
  old_text: Text(PROFILE_LINE_MAX)
    .optional()
    .describe("patch, remove: text from one entry."),
})

/** `memory`'s input: one target, every change to it in one batch, applied together or not at all. */
export const MemoryInput = z.strictObject({
  target: MemoryTarget,
  operations: z.array(MemoryOperation).min(1).max(8),
})

/**
 * `memory`'s output. `saved` says the write is complete. `full` carries the
 * store's current entries so one batch can consolidate and add together;
 * `stopped` ends the retries for the turn. Anything else is a `Refused`.
 */
export const MemoryOutput = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("saved"),
    target: MemoryTarget,
    note: Text(200),
    fullness: Text(60),
    entry_count: z.int().nonnegative(),
    /** Each entry a patch changed, before and after. */
    patched: z
      .array(
        z.strictObject({
          before: Text(PROFILE_LINE_MAX),
          after: Text(PROFILE_LINE_MAX),
        })
      )
      .min(1)
      .max(8)
      .optional(),
  }),
  z.strictObject({
    outcome: z.literal("full"),
    target: MemoryTarget,
    note: Text(400),
    fullness: Text(60),
    current_entries: z
      .array(Text(PROFILE_LINE_MAX))
      .max(linesWithin(NOTES_MAX_CHARS)),
  }),
  z.strictObject({ outcome: z.literal("stopped"), note: Text(200) }),
  Refused.extend({
    /** On a no-match, the entries sharing the most words with old_text. */
    closest_entries: z.array(Text(PROFILE_LINE_MAX)).min(1).max(3).optional(),
  }),
])

/** One profile version, as the owner's page lists it. */
export const ProfileVersion = z.strictObject({
  version: z.int().positive(),
  at: Timestamp,
  /** What changed against the version before it, in the owner's terms. */
  changes: z
    .array(
      z.strictObject({
        kind: z.enum(["added", "changed", "removed"]),
        text: Text(PROFILE_LINE_MAX),
        source: ProfileSource,
      })
    )
    .max(40),
})

/** One store as the owner's page shows it: its lines, its budget and the versions behind them. */
export const MemoryLayer = z.strictObject({
  version: z.int().nonnegative(),
  lines: z.array(ProfileLine),
  max: z.int().positive(),
  versions: z.array(ProfileVersion).max(50),
})

/**
 * One skill's notes for this business, under the skill's plain name. A
 * line is `stale` once its skill has not loaded for 60 days (after Hermes's
 * curator): shown to the owner, never removed for it.
 */
export const SkillNotesView = z.strictObject({
  name: SkillName,
  title: Text(80),
  max: z.int().positive(),
  lines: z
    .array(ProfileLine.extend({ stale: z.boolean() }))
    .max(linesWithin(SKILL_NOTES_MAX_CHARS)),
})

/**
 * `GET /memory`: the profile's lines and the versions behind them, newest
 * first; the working notes and every skill's notes the same way; and the
 * owner's corrections for staff. The page only shows them: the owner
 * changes memory by telling the assistant.
 */
export const MemoryView = z.strictObject({
  version: z.int().nonnegative(),
  lines: z.array(ProfileLine),
  versions: z.array(ProfileVersion).max(50),
  notes: MemoryLayer,
  skills: z.strictObject({
    version: z.int().nonnegative(),
    notes: z.array(SkillNotesView).max(40),
    versions: z.array(ProfileVersion).max(50),
  }),
  ask_first: z.boolean(),
  proposals: z.array(MemoryProposal).max(10),
  corrections: StaffCorrections.shape.lines,
})

/** `POST /memory/review`: the owner's choice, or their answer to one proposal. */
export const MemoryReviewAction = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("ask_first"), value: z.boolean() }),
  z.strictObject({ action: z.literal("accept"), id: Uuid }),
  z.strictObject({ action: z.literal("dismiss"), id: Uuid }),
])

/** The `data-memory` part: "Saved to memory", shown once on the turn after a write. */
export const MemoryChip = z.strictObject({
  version: z.int().positive(),
  changes: ProfileVersion.shape.changes,
})

export type ProfileLine = z.infer<typeof ProfileLine>
export type OwnerProfile = z.infer<typeof OwnerProfile>
export type OwnerMemoryReview = z.infer<typeof OwnerMemoryReview>
export type RememberOperation = z.infer<typeof RememberOperation>
export type RememberInput = z.infer<typeof RememberInput>
export type RememberOutput = z.infer<typeof RememberOutput>
export type ProfileVersion = z.infer<typeof ProfileVersion>
export type MemoryView = z.infer<typeof MemoryView>
export type MemoryProposal = z.infer<typeof MemoryProposal>
export type MemoryReviewAction = z.infer<typeof MemoryReviewAction>
export type MemoryChip = z.infer<typeof MemoryChip>
export type MemoryOperation = z.infer<typeof MemoryOperation>
export type MemoryInput = z.infer<typeof MemoryInput>
export type MemoryOutput = z.infer<typeof MemoryOutput>
export type MemoryTarget = z.infer<typeof MemoryTarget>
export type MemoryLayer = z.infer<typeof MemoryLayer>
export type SkillNoteLine = z.infer<typeof SkillNoteLine>
export type SkillNotes = z.infer<typeof SkillNotes>
export type SkillNotesView = z.infer<typeof SkillNotesView>
