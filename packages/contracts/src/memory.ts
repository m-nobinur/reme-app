import { z } from "zod"
import { Timestamp, Uuid } from "./common.ts"
import { BUSINESS_ADDRESS_KEY } from "./domain.ts"
import { Refused } from "./refused.ts"
import { Text } from "./text.ts"

// What the Chief of Staff remembers about the owner (ADR-042): one fact of
// plain lines, versioned like any fact, so each change can be undone.

/** The profile's fact key. The profile is data about the person, not the business. */
export const OWNER_PROFILE_KEY = "owner.profile"

/** The owner's "Ask me before saving" choice, the changes reflection proposed, and how far the chat has shown the profile's changes. */
export const OWNER_MEMORY_REVIEW_KEY = "owner.memory_review"

/**
 * Facts that belong to the Chief of Staff's memory of the owner, and the
 * business address Your details keeps. Every reader of the business's facts
 * leaves them out: they never reach a builder snapshot, `get_facts`, the
 * website or the claims gate (§8.5).
 */
export const PRIVATE_FACT_KEYS: readonly string[] = [
  OWNER_PROFILE_KEY,
  OWNER_MEMORY_REVIEW_KEY,
  BUSINESS_ADDRESS_KEY,
]

/** The most the profile may hold, counted on its rendered text. */
export const PROFILE_MAX_CHARS = 1_500
export const PROFILE_LINE_MAX = 300

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
  .strictObject({ lines: z.array(ProfileLine).max(40) })
  .refine((p) => profileText(p.lines).length <= PROFILE_MAX_CHARS, {
    message: `The profile holds at most ${PROFILE_MAX_CHARS} characters.`,
  })

/**
 * A change reflection wants to make while "Ask me before saving" is on. It
 * waits on the owner's page: accepting it saves it as `owner_confirmed`.
 * `was` is the whole line a replace or remove would touch.
 */
export const MemoryProposal = z.strictObject({
  id: Uuid,
  action: z.enum(["add", "replace", "remove"]),
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

/** `remember`'s input: every change in one call, applied together or not at all. */
export const RememberInput = z.strictObject({
  operations: z.array(RememberOperation).min(1).max(8),
})

/**
 * `remember`'s output. `saved` says the write is complete. `full` carries
 * the current lines so the next call can merge or remove first; `stopped`
 * ends the retries for the turn. Anything else is a `Refused`.
 */
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
  /** Whether undoing this change still applies to the current lines. */
  undoable: z.boolean(),
})

/** `GET /memory`: the current lines and the versions behind them, newest first. */
export const MemoryView = z.strictObject({
  version: z.int().nonnegative(),
  lines: z.array(ProfileLine),
  versions: z.array(ProfileVersion).max(50),
  ask_first: z.boolean(),
  proposals: z.array(MemoryProposal).max(10),
})

/** `POST /memory/review`: the owner's choice, or their answer to one proposal. */
export const MemoryReviewAction = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("ask_first"), value: z.boolean() }),
  z.strictObject({ action: z.literal("accept"), id: Uuid }),
  z.strictObject({ action: z.literal("dismiss"), id: Uuid }),
])

/** `POST /memory/undo`: undoes the newest version, named so a stale page undoes nothing. */
export const MemoryUndo = z.strictObject({ version: z.int().positive() })

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
export type MemoryUndo = z.infer<typeof MemoryUndo>
export type MemoryChip = z.infer<typeof MemoryChip>
