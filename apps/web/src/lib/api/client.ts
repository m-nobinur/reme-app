import { getCookie } from "@tanstack/react-start/server"
import { Org, StaffDirectory } from "@workspace/contracts"
import type { OrgNode, OrgSummary, OwnerDataSource, StaffMember } from "./types"

/**
 * The owner screens, read from `apps/api` over the contracts.
 *
 * This is what `mock.ts` was standing in for. Every value on every screen now
 * comes from a row a tenant owns, resolved from their own session: no request
 * from here names an organisation, in any spelling, because `apps/api` produces
 * the org id from the sealed session and would not read one if we sent it.
 * `orgId` is still a parameter of `OwnerDataSource` and is deliberately unused
 * below.
 *
 * Five of the nine reads have no endpoint yet. They answer empty rather than
 * inventing rows, which is the state every one of those screens already has to
 * render and is what an owner on their first day genuinely has. Nothing here
 * falls back to a fixture: an empty inbox is true, and a fixture business on a
 * tenant's screen is not (exit gate 9, R8).
 */

/** The cookie AuthKit writes and `apps/api` reads (ADR-024, ADR-026). */
const COOKIE = "wos-session"

/**
 * Where `apps/api` answers. A `vars` entry rather than a secret, because it is
 * a public URL. Three lines rather than an import from `lib/auth/org.ts`, which
 * would drag `@workos-inc/node` into the graph of every product loader for the
 * sake of a `process.env` read.
 */
function apiUrl(): string {
  const value = process.env.REME_API_URL
  if (!value) {
    throw new Error(
      "REME_API_URL is not set on this Worker. Local values go in apps/web/.dev.vars; the deployed value is a vars entry in wrangler.jsonc."
    )
  }
  return value
}

/**
 * One read, with the session forwarded.
 *
 * Only the session cookie is forwarded, rebuilt by name rather than by passing
 * the browser's `Cookie` header through: the organisation the owner picked and
 * anything else a page has set are ours and are not `apps/api`'s business.
 *
 * 401 and 403 answer null rather than throwing. Both mean "this session has no
 * organisation to read", which every screen renders as its empty state: 403
 * `org.unresolved` is the state a signup lands in for a moment (open item 32),
 * and the layout guard has already refused a request with no session at all, so
 * a 401 here is a session that expired between the guard and this call. Any
 * other status is a defect and is thrown, so it reaches an error boundary
 * rather than a screen of zeros.
 */
async function get(path: string): Promise<unknown | null> {
  const session = getCookie(COOKIE)
  if (!session) {
    return null
  }
  const response = await fetch(new URL(path, apiUrl()), {
    headers: { cookie: `${COOKIE}=${encodeURIComponent(session)}` },
  })
  if (response.status === 401 || response.status === 403) {
    return null
  }
  if (!response.ok) {
    throw new Error(`apps/api answered ${response.status} for ${path}`)
  }
  return await response.json()
}

/**
 * The reporting lines the directory draws, built from `manager_staff_id` in one
 * pass. Roots are the rows whose manager is not in this org's own list, so a row
 * pointing at a manager the reader cannot see is still drawn rather than
 * silently dropped.
 */
export function treeOf(members: StaffMember[]): OrgNode[] {
  const nodes = new Map<string, OrgNode>(
    members.map((staff) => [staff.id, { staff, reports: [] }])
  )
  const roots: OrgNode[] = []
  for (const node of nodes.values()) {
    const parent = node.staff.managerId
      ? nodes.get(node.staff.managerId)
      : undefined
    if (parent) {
      parent.reports.push(node)
    } else {
      roots.push(node)
    }
  }
  return roots
}

async function currentOrg(): Promise<OrgSummary | null> {
  const body = await get("/org")
  if (body === null) {
    return null
  }
  // Parsed rather than read loosely, so a drift between the contract and what
  // the API answers fails here instead of two screens later.
  const org = Org.parse(body)
  return { id: org.org_id, slug: org.slug, name: org.name }
}

/**
 * `role_id` and `department_id` are ids, and there is no read that turns either
 * into a title yet, so both render as "—" rather than as a guess. The column
 * the directory shows in the meantime is `position_title`, which is on the row.
 */
async function staffOf(): Promise<StaffMember[]> {
  const body = await get("/staff")
  if (body === null) {
    return []
  }
  return StaffDirectory.parse(body).staff.map((member) => ({
    id: member.staff_id,
    staffCode: member.staff_code,
    displayName: member.display_name,
    kind: member.kind,
    positionTitle: member.position_title,
    roleTitle: null,
    departmentName: null,
    managerId: member.manager_staff_id,
    status: member.status,
  }))
}

export const apiSource: OwnerDataSource = {
  // The switcher's list. One organisation per session today, because that is
  // what a session's `org_id` claim resolves to and what signup creates.
  orgs: async () => {
    const org = await currentOrg()
    return org ? [org] : []
  },
  staff: staffOf,
  orgTree: async () => treeOf(await staffOf()),
  attention: async () => [],
  approvals: async () => [],
  pipeline: async () => [],
  activity: async () => [],
  profile: async () => {
    const org = await currentOrg()
    return org ? { org, facts: [] } : null
  },
  // Unreachable while `approvals` is empty: there is no card to decide from.
  // It refuses rather than returning quietly, because the one thing worse than
  // an approvals screen with nothing on it is one that accepts a decision and
  // records it nowhere.
  decideApproval: async () => {
    throw new Error("no endpoint records an approval decision yet")
  },
}
