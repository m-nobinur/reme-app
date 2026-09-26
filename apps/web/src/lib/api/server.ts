import { createServerFn } from "@tanstack/react-start"
import {
  getCookie,
  getRequestProtocol,
  setCookie,
} from "@tanstack/react-start/server"
import { PANEL_COOKIE } from "@workspace/ui/lib/panel"
import { readWaiting } from "@/lib/attention"
import { oneOf, record, text } from "@/lib/auth/input"
import { source } from "./source"
import type {
  ApprovalItem,
  AttentionItem,
  BusinessProfile,
  DecisionOutcome,
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

/** The organisation the cookie picked, if it is one of the owner's own. */
function pickOrg(orgs: OrgSummary[]): OrgSummary | null {
  const picked = getCookie(ORG_COOKIE)
  return orgs.find((org) => org.slug === picked) ?? orgs[0] ?? null
}

async function activeOrg(): Promise<OrgSummary | null> {
  return pickOrg(await source.orgs())
}

/**
 * What the workspace frame needs on every /app page: the switcher's options
 * and selection, whether the panel is open, and what is waiting on the owner.
 * The panel state is read here, on the server, so the first paint already has
 * the panel where the owner left it.
 */
export const getWorkspaceFrame = createServerFn({ method: "GET" }).handler(
  async (): Promise<{
    orgs: OrgSummary[]
    active: OrgSummary | null
    panelOpen: boolean
    /** Null when the read failed: the frame still renders, and says so. */
    waiting: AttentionItem[] | null
  }> => {
    const orgs = await source.orgs()
    const active = pickOrg(orgs)
    return {
      orgs,
      active,
      panelOpen: getCookie(PANEL_COOKIE) !== "closed",
      waiting: active
        ? await readWaiting(() =>
            source.attention(active.id, source.staff(active.id))
          )
        : [],
    }
  }
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
      // The revision the owner was shown, which the decision binds to.
      revisionId: text(data.revisionId, 64),
      decision: oneOf(data.decision, ["approved", "rejected"] as const),
    }
  })
  .handler(async ({ data }): Promise<DecisionOutcome> => {
    const org = await activeOrg()
    if (!org || !data.approvalId || !data.revisionId) {
      throw new Error("no approval to decide")
    }
    return await source.decideApproval(
      org.id,
      data.approvalId,
      data.revisionId,
      data.decision
    )
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
