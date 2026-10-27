import { z } from "zod"
import { Timestamp, Uuid } from "./common.ts"
import { DomainName } from "./domain.ts"
import { Text } from "./text.ts"

// Owner tasks: work the assistant leads over days, stored as steps so the
// panel, the assistant's workspace view and the heartbeat read the same rows.
// `domains` and `search_connections` stay the record of their own facts; a
// task holds progress and what the owner is asked to do.

/** What a task is for: the site's own address, or Google Search Console. */
export const TaskKind = z.enum(["address", "google"])

/** `later` is put off until `later_until`; `declined` is the owner saying no. */
export const TaskState = z.enum(["active", "done", "declined", "later"])

/** `blocked` waits on the owner, with `blocked_on` and a note; `skipped` does not apply. */
export const TaskStepState = z.enum([
  "pending",
  "in_progress",
  "blocked",
  "done",
  "skipped",
])

/** What a blocked step waits for from the owner. */
export const TaskBlockedOn = z.enum([
  "approval",
  "owner_action",
  "purchase",
  "permission",
])

/** The address task's steps, in order: find out, choose, buy, then connect. */
export const ADDRESS_TASK_STEPS = [
  "find_out",
  "choose",
  "purchase",
  "records",
  "ownership",
  "certificate",
  "loads",
] as const

/** The Google task's steps, in order. */
export const GOOGLE_TASK_STEPS = [
  "sign_in",
  "permissions",
  "verify",
  "sitemap",
  "first_data",
] as const

export const AddressStep = z.enum(ADDRESS_TASK_STEPS)
export const GoogleStep = z.enum(GOOGLE_TASK_STEPS)
/** Every step name, both kinds: the `task_step` enum in the database. */
export const TaskStepName = z.enum([
  ...ADDRESS_TASK_STEPS,
  ...GOOGLE_TASK_STEPS,
])

/** How the owner came to the address: had it, buying it elsewhere, or bought it with us. */
export const AddressOrigin = z.enum(["owned", "buying_elsewhere", "purchased"])

/** The address task's `detail`: what is known so far, every field optional until then. */
export const AddressDetail = z.strictObject({
  name: DomainName.optional(),
  /** The DNS host's name, from detection. */
  provider: Text(80).optional(),
  /** The registrar's name, from RDAP. */
  registrar: Text(80).optional(),
  origin: AddressOrigin.optional(),
  /** The ending the owner chose, such as "co.uk". */
  ending: z
    .string()
    .regex(/^[a-z]{2,24}(\.[a-z]{2,24})?$/)
    .optional(),
})

/** One step as the api returns it: no probe hash, no evidence body. */
const stepOf = <S extends z.ZodType>(step: S) =>
  z.strictObject({
    step,
    state: TaskStepState,
    /** Why it waits, in the owner's terms, written by code: data, never instructions. */
    note: Text(200).nullable(),
    blocked_on: TaskBlockedOn.nullable(),
    /** When the owner's chance closes, for a blocked step. */
    deadline: Timestamp.nullable(),
    /** When the state last moved. */
    changed_at: Timestamp.nullable(),
  })

export const AddressTaskStep = stepOf(AddressStep)
export const GoogleTaskStep = stepOf(GoogleStep)

const taskBase = {
  id: Uuid,
  state: TaskState,
  later_until: Timestamp.nullable(),
  created_at: Timestamp,
  done_at: Timestamp.nullable(),
}

/** A task with its steps in order, one per step name of its kind. */
export const OwnerTask = z.discriminatedUnion("kind", [
  z.strictObject({
    ...taskBase,
    kind: z.literal("address"),
    detail: AddressDetail,
    steps: z.array(AddressTaskStep).max(ADDRESS_TASK_STEPS.length),
  }),
  z.strictObject({
    ...taskBase,
    kind: z.literal("google"),
    detail: z.strictObject({}),
    steps: z.array(GoogleTaskStep).max(GOOGLE_TASK_STEPS.length),
  }),
])

export type TaskKind = z.infer<typeof TaskKind>
export type TaskState = z.infer<typeof TaskState>
export type TaskStepState = z.infer<typeof TaskStepState>
export type TaskBlockedOn = z.infer<typeof TaskBlockedOn>
export type TaskStepName = z.infer<typeof TaskStepName>
export type AddressDetail = z.infer<typeof AddressDetail>
export type OwnerTask = z.infer<typeof OwnerTask>
