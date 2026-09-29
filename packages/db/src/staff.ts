import { eq, sql } from "drizzle-orm"
import { appendEvent } from "./events.ts"
import { staff, staffEvents } from "./schema.ts"
import type { OrgScopedDb } from "./tenancy.ts"

/** The starting team's staff codes (§5.2), the same in every org. */
export const STAFF_CODE = {
  owner: "OWN-001",
  chief: "COS-001",
  developer: "DEV-001",
} as const

/**
 * The team every org starts with (§5.2): the owner as the human root, a Chief
 * of Staff reporting to the root and a Developer reporting to the Chief, so
 * the first build has someone to run it. Names are the golden fixtures'. Role
 * and department stay null: a new org has no rows of either to point at.
 *
 * Safe to call again, and on an org made before this: each insert does
 * nothing on any unique conflict, the code or the one-root index, so a second
 * call adds nobody and an org whose root has another code keeps it. Each
 * manager comes from a subquery in the insert rather than a read back, so no
 * statement returns a row (the reason `apps/api`'s `createOrg` gives). `userId` is our
 * `users.id`, and the owner needs a membership in this org first, because
 * `staff_user_fk` points at it.
 *
 * Each row this call inserts is a hire, recorded the way the golden fixtures
 * record one: a `hired` row in `staff_events` and a sessionless `staff.hired`
 * event, both with the org's root as actor, in the caller's transaction. A row
 * that met a conflict was hired before, so a second call records nothing. A
 * row made before hires were recorded stays without a record rather than
 * getting one dated today.
 */
export async function ensureStartingTeam(
  db: OrgScopedDb,
  team: { orgId: string; userId: string; ownerName: string }
): Promise<void> {
  const { orgId } = team
  const root = sql`(select ${staff.id} from ${staff} where ${staff.orgId} = ${orgId} and ${staff.kind} = 'human' and ${staff.managerId} is null)`
  const chief = sql`(select ${staff.id} from ${staff} where ${staff.orgId} = ${orgId} and ${staff.staffCode} = ${STAFF_CODE.chief})`
  const hired = { orgId, status: "active" as const }
  const owner = await db
    .insert(staff)
    .values({
      ...hired,
      staffCode: STAFF_CODE.owner,
      displayName: team.ownerName,
      kind: "human",
      userId: team.userId,
      positionTitle: "Owner",
    })
    .onConflictDoNothing()
  const cos = await db
    .insert(staff)
    .values({
      ...hired,
      staffCode: STAFF_CODE.chief,
      displayName: "Maya",
      kind: "agent",
      managerId: root,
      positionTitle: "Chief of Staff",
    })
    .onConflictDoNothing()
  const dev = await db
    .insert(staff)
    .values({
      ...hired,
      staffCode: STAFF_CODE.developer,
      displayName: "Alex",
      kind: "agent",
      managerId: chief,
      positionTitle: "Developer",
    })
    .onConflictDoNothing()
  const inserted = Object.entries({
    [STAFF_CODE.owner]: owner,
    [STAFF_CODE.chief]: cos,
    [STAFF_CODE.developer]: dev,
  })
    .filter(
      ([, result]) => (result as unknown as { count: number }).count === 1
    )
    .map(([code]) => code)
  if (inserted.length === 0) return
  const actor = await rootStaffId(db)
  for (const code of inserted) {
    const [row] = await db
      .select({ id: staff.id })
      .from(staff)
      .where(sql`${staff.orgId} = ${orgId} and ${staff.staffCode} = ${code}`)
    const staffId = row?.id as string
    await db
      .insert(staffEvents)
      .values({ orgId, staffId, kind: "hired", actorStaffId: actor })
    await appendEvent(db, {
      orgId,
      assignmentId: null,
      staffId,
      type: "staff.hired",
      payload: {},
    })
  }
}

/** The org's human root, the owner's staff row, or null before the team exists. */
export async function rootStaffId(db: OrgScopedDb): Promise<string | null> {
  const [root] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(sql`${staff.kind} = 'human' and ${staff.managerId} is null`)
  return root?.id ?? null
}

/** The org's Chief of Staff staff row, or null for an org made before the starting team. */
export async function chiefStaffId(db: OrgScopedDb): Promise<string | null> {
  const [row] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(eq(staff.staffCode, STAFF_CODE.chief))
  return row?.id ?? null
}
