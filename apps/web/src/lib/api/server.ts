import { createServerFn } from "@tanstack/react-start"
import {
  getCookie,
  getRequestProtocol,
  setCookie,
} from "@tanstack/react-start/server"
import type { Conversation } from "@workspace/contracts"
import { GOAL_MAX, Uuid } from "@workspace/contracts"
import { PANEL_COOKIE } from "@workspace/ui/lib/panel"
import { EMPTY_WORKSPACE, readWorkspace, waitingOnOwner } from "@/lib/attention"
import { oneOf, record, text } from "@/lib/auth/input"
import { source } from "./source"
import type {
  ApprovalItem,
  BusinessProfile,
  DecisionOutcome,
  Json,
  OrgNode,
  OrgSummary,
  PipelineItem,
  PreviewLinks,
  StaffMember,
  TransportedMessage,
  Workspace,
  WriteOutcome,
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

/** The organisation a write acts for. A write with none is refused, never guessed. */
async function writingOrg(): Promise<OrgSummary> {
  const org = await activeOrg()
  if (!org) {
    throw new Error("no organisation to act for")
  }
  return org
}

/** An id off the wire: a UUID, or a refusal. */
function id(value: unknown): string {
  const read = Uuid.safeParse(value)
  if (!read.success) {
    throw new Error("Expected a UUID.")
  }
  return read.data
}

/** assistant-ui's local thread id, the key a first send is stored under. */
function localId(value: unknown): string {
  if (typeof value !== "string" || !/^[\w-]{1,64}$/.test(value)) {
    throw new Error("Expected a thread id.")
  }
  return value
}

/** The caller's idempotency key, or a fresh one: a key is never empty. */
const keyOf = (value: unknown) => text(value, 255) || crypto.randomUUID()

/** The conversations list for the rail, or null when it could not be read. */
async function readConversations(
  orgId: string
): Promise<Conversation[] | null> {
  try {
    return await source.conversations(orgId)
  } catch {
    return null
  }
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
    /**
     * What waits on the owner, and where the site is. Null when the read
     * failed: the frame still renders, and says so.
     */
    workspace: Workspace | null
    /** The rail's conversations. Null when the read failed. */
    conversations: Conversation[] | null
    /** Staff names by id, for naming who asked in a polled workspace. */
    names: Record<string, string>
  }> => {
    const orgs = await source.orgs()
    const active = pickOrg(orgs)
    if (!active) {
      return {
        orgs,
        active,
        panelOpen: getCookie(PANEL_COOKIE) !== "closed",
        workspace: EMPTY_WORKSPACE,
        conversations: [],
        names: {},
      }
    }
    const staff = source.staff(active.id)
    const [workspace, conversations, members] = await Promise.all([
      readWorkspace(() => source.workspace(active.id, staff)),
      readConversations(active.id),
      staff.catch(() => []),
    ])
    return {
      orgs,
      active,
      panelOpen: getCookie(PANEL_COOKIE) !== "closed",
      workspace,
      conversations,
      names: Object.fromEntries(
        members.map((member) => [member.id, member.displayName])
      ),
    }
  }
)

/**
 * The panel's poll, with the tag it last saw. One request: `apps/api`
 * resolves the org from the session, and a session with none reads as an
 * empty workspace. A failure throws, so the poller backs off rather than
 * rendering a workspace of nothing.
 */
export const pollWorkspace = createServerFn({ method: "GET" })
  .validator((input: unknown) => ({
    etag: text(record(input).etag, 128) || null,
  }))
  .handler(
    async ({
      data,
    }): Promise<
      { changed: false } | { changed: true; workspace: Workspace }
    > => {
      const read = await source.pollWorkspace(data.etag)
      if (read === "unchanged") {
        return { changed: false }
      }
      return {
        changed: true,
        workspace: { ...read, attention: waitingOnOwner(read.attention) },
      }
    }
  )

/** The most an answer can weigh: a text answer is at most 500 characters. */
const ANSWER_BYTES = 2048

export const answerQuestion = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const data = record(input)
    if (JSON.stringify(data.value ?? null).length > ANSWER_BYTES) {
      throw new Error("That answer is too long.")
    }
    return {
      assignmentId: id(data.assignmentId),
      requestId: id(data.requestId),
      value: data.value as Json,
      key: keyOf(data.key),
    }
  })
  .handler(async ({ data }): Promise<WriteOutcome> => {
    const org = await writingOrg()
    return await source.answer(
      org.id,
      data.assignmentId,
      data.requestId,
      data.value,
      data.key
    )
  })

export const cancelBuild = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({
    assignmentId: id(record(input).assignmentId),
  }))
  .handler(async ({ data }): Promise<WriteOutcome> => {
    const org = await writingOrg()
    return await source.cancelBuild(org.id, data.assignmentId)
  })

export const getPreview = createServerFn({ method: "GET" })
  .validator((input: unknown) => ({
    assignmentId: id(record(input).assignmentId),
  }))
  .handler(async ({ data }): Promise<PreviewLinks | null> => {
    const org = await activeOrg()
    return org ? await source.preview(org.id, data.assignmentId) : null
  })

export const askForChanges = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const data = record(input)
    return { text: text(data.text, GOAL_MAX), key: keyOf(data.key) }
  })
  .handler(async ({ data }): Promise<WriteOutcome> => {
    const org = await writingOrg()
    if (!data.text) {
      return { done: false, reason: "Write what should change first." }
    }
    return await source.requestChange(org.id, data.text, data.key)
  })

export const listConversations = createServerFn({ method: "GET" }).handler(
  async (): Promise<Conversation[]> => {
    const org = await activeOrg()
    return org ? await source.conversations(org.id) : []
  }
)

/** Null for an id that is not one of the owner's, a UUID or not. */
export const getConversation = createServerFn({ method: "GET" })
  .validator((input: unknown) => {
    const read = Uuid.safeParse(record(input).id)
    return { id: read.success ? read.data : null }
  })
  .handler(async ({ data }): Promise<Conversation | null> => {
    const org = data.id ? await activeOrg() : null
    return org && data.id ? await source.conversation(org.id, data.id) : null
  })

/**
 * Idempotent on the thread's local id, so a retried first send makes one
 * row. Null for a session with no organisation, which has nowhere to store
 * one; the thread then stays in the tab.
 */
export const createConversation = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ key: localId(record(input).localId) }))
  .handler(async ({ data }): Promise<Conversation | null> => {
    const org = await activeOrg()
    return org ? await source.createConversation(org.id, data.key) : null
  })

export const updateConversation = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const data = record(input)
    const patch =
      typeof data.archived === "boolean"
        ? { archived: data.archived }
        : { title: text(data.title, 120) }
    if ("title" in patch && !patch.title) {
      throw new Error("A title needs words.")
    }
    return { id: id(data.id), patch, key: keyOf(data.key) }
  })
  .handler(async ({ data }): Promise<void> => {
    const org = await writingOrg()
    await source.updateConversation(org.id, data.id, data.patch, data.key)
  })

export const getConversationMessages = createServerFn({ method: "GET" })
  .validator((input: unknown) => ({ id: id(record(input).id) }))
  .handler(async ({ data }): Promise<TransportedMessage[]> => {
    const org = await activeOrg()
    return org ? await source.conversationMessages(org.id, data.id) : []
  })

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
