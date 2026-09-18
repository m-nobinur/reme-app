import { createServerFn } from "@tanstack/react-start"
import {
  getCookie,
  getRequestProtocol,
  setCookie,
} from "@tanstack/react-start/server"
import { record, text } from "@/lib/auth/input"
import { source } from "./source"
import type {
  ActivityItem,
  ApprovalItem,
  AttentionItem,
  BusinessProfile,
  OrgNode,
  OrgSummary,
  PipelineItem,
  StaffMember,
} from "./types"

/**
 * The server half of every product screen. Loaders call these; nothing calls
 * `source` directly, so no implementation reaches the client graph and
 * `source.ts` stays the only module that names one.
 *
 * Each function resolves the organisation itself. No screen passes an
 * organisation id, and none accepts one: the id is looked up from the owner's
 * own list on the server, which is the shape §9.2 layer 1 requires and R3
 * states as "org_id never comes from client input". The cookie below holds a
 * slug the owner picked, and a slug that is not one of their organisations is
 * discarded rather than trusted. When the session carries the organisation
 * (D3), `activeOrg` reads it from there and the cookie goes.
 */

const ORG_COOKIE = "reme-org"

async function activeOrg(): Promise<OrgSummary | null> {
  const orgs = await source.orgs()
  if (orgs.length === 0) {
    return null
  }
  const picked = getCookie(ORG_COOKIE)
  return orgs.find((org) => org.slug === picked) ?? orgs[0] ?? null
}

/** What the layout needs: the switcher's options and the current selection. */
export const getOrgContext = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ orgs: OrgSummary[]; active: OrgSummary | null }> => ({
    orgs: await source.orgs(),
    active: await activeOrg(),
  })
)

/**
 * Switching organisation is the one act that legitimately names one, which is
 * why this is the second caller of `record`'s `allowOrgKeys` escape hatch after
 * `/choose-organisation`. The guard still fires on every other key, and naming
 * the field `organisation` rather than something the check does not recognise
 * is the point: an exception that has to be declared is reviewable, and one
 * that is spelled around is not.
 *
 * The value is a claim, not an answer. The handler resolves it against the
 * owner's own organisations and writes nothing if it is not one of them, so the
 * organisation the screens read still comes from the server.
 */
export const selectOrg = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({
    slug: text(record(input, ["organisation"]).organisation, 64),
  }))
  .handler(async ({ data }): Promise<{ slug: string | null }> => {
    // Membership decides, not the request. An unknown slug writes nothing.
    const orgs = await source.orgs()
    const chosen = orgs.find((org) => org.slug === data.slug)
    if (!chosen) {
      return { slug: null }
    }
    setCookie(ORG_COOKIE, chosen.slug, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      // Dev runs on http and deployments on https, so this is read from the
      // request rather than hard-coded either way.
      secure: getRequestProtocol() === "https",
      maxAge: 60 * 60 * 24 * 30,
    })
    return { slug: chosen.slug }
  })

export type DashboardData = {
  org: OrgSummary | null
  attention: AttentionItem[]
  activity: ActivityItem[]
  counts: { staff: number; waiting: number; pipeline: number }
}

export const getDashboard = createServerFn({ method: "GET" }).handler(
  async (): Promise<DashboardData> => {
    const org = await activeOrg()
    if (!org) {
      return {
        org,
        attention: [],
        activity: [],
        counts: { staff: 0, waiting: 0, pipeline: 0 },
      }
    }
    const [attention, activity, staff, pipeline] = await Promise.all([
      source.attention(org.id),
      source.activity(org.id),
      source.staff(org.id),
      source.pipeline(org.id),
    ])
    return {
      org,
      attention,
      activity,
      counts: {
        staff: staff.filter((member) => member.status === "active").length,
        waiting: attention.length,
        // "Needs action" is a follow-up date, not a stage: a completed lead
        // with nothing scheduled is not waiting on anyone.
        pipeline: pipeline.filter((item) => item.followUpAt !== null).length,
      },
    }
  }
)

export const getStaffDirectory = createServerFn({ method: "GET" }).handler(
  async (): Promise<{
    org: OrgSummary | null
    staff: StaffMember[]
    tree: OrgNode[]
  }> => {
    const org = await activeOrg()
    if (!org) {
      return { org, staff: [], tree: [] }
    }
    const [staff, tree] = await Promise.all([
      source.staff(org.id),
      source.orgTree(org.id),
    ])
    return { org, staff, tree }
  }
)

export const getApprovals = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ org: OrgSummary | null; approvals: ApprovalItem[] }> => {
    const org = await activeOrg()
    return {
      org,
      approvals: org ? await source.approvals(org.id) : [],
    }
  }
)

export const decideApproval = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const data = record(input)
    return {
      approvalId: text(data.approvalId, 64),
      decision: data.decision === "approved" ? "approved" : "declined",
    } as const
  })
  .handler(async ({ data }): Promise<void> => {
    const org = await activeOrg()
    if (!org || !data.approvalId) {
      return
    }
    await source.decideApproval(org.id, data.approvalId, data.decision)
  })

export const getPipeline = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ org: OrgSummary | null; items: PipelineItem[] }> => {
    const org = await activeOrg()
    return { org, items: org ? await source.pipeline(org.id) : [] }
  }
)

export const getBusinessProfile = createServerFn({ method: "GET" }).handler(
  async (): Promise<BusinessProfile | null> => {
    const org = await activeOrg()
    return org ? await source.profile(org.id) : null
  }
)
