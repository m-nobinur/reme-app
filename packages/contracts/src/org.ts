import { z } from "zod"
import { Timestamp, Uuid } from "./common.ts"

/**
 * The two read shapes the app needs before it can render anything: the org the
 * caller is signed in to, and its staff.
 *
 * Neither is in the §19 table, which is the destination for the payloads that
 * cross a team boundary between the tracks. These cross the one boundary that
 * table takes for granted: the Core API to the web app. They arrive with the
 * first endpoints that produce them.
 */

/**
 * What signup posts to the Core API to bring an org into existence (ADR-029).
 *
 * The name and nothing else. There is no organisation id in it, in any spelling:
 * the WorkOS organization is created by the API, from this name, so the id that
 * the tenant is later resolved by never travels over this boundary and cannot
 * be chosen by a caller. The slug is derived from the name for the same reason,
 * rather than accepted, since a caller that picks slugs can probe which ones
 * are taken.
 *
 * `120` is a bound rather than a rule about names: `orgs.name` is `text` and
 * the value ends up on a WorkOS organization, so this refuses a megabyte of
 * form field before it reaches either.
 */
export const CreateOrgRequest = z.strictObject({
  name: z.string().min(1).max(120),
})

/** §5.2. The tenant root, as a screen shows it. */
export const Org = z.strictObject({
  org_id: Uuid,
  /** Stable handle. Used by fixtures, dev URLs and the org switcher. */
  slug: z.string().min(1),
  name: z.string().min(1),
  created_at: Timestamp,
})

/** §5.2. A staff member is an org record; a human is one with a `user_id`. */
export const StaffMember = z.strictObject({
  staff_id: Uuid,
  org_id: Uuid,
  /** Human-readable, e.g. `COS-001`. Unique per org, never reused. */
  staff_code: z.string().min(1),
  display_name: z.string().min(1),
  kind: z.enum(["agent", "human"]),
  /** §5.4 lifecycle. */
  status: z.enum([
    "draft",
    "onboarding",
    "active",
    "paused",
    "suspended",
    "offboarding",
    "archived",
  ]),
  position_title: z.string().nullable(),
  /** The reporting line. Null only for the org root, the owner's proxy. */
  manager_staff_id: Uuid.nullable(),
  role_id: Uuid.nullable(),
  department_id: Uuid.nullable(),
  created_at: Timestamp,
  updated_at: Timestamp,
})

/**
 * An object rather than a bare array, so the page cursor this will need can be
 * added beside the rows rather than by changing the response into something
 * else. Ordering is the API's, not the caller's: `staff_code`, which is stable
 * and unique per org.
 */
export const StaffDirectory = z.strictObject({
  staff: z.array(StaffMember),
})

export type CreateOrgRequest = z.infer<typeof CreateOrgRequest>
export type Org = z.infer<typeof Org>
export type StaffMember = z.infer<typeof StaffMember>
export type StaffDirectory = z.infer<typeof StaffDirectory>
