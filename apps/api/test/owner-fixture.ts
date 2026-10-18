import type { AssignmentState } from "@workspace/contracts"
import {
  approvals,
  assignments,
  assignmentTransitions,
  conversationMessages,
  deployments,
  eq,
  events,
  siteRevisions,
  staff,
  type Tenancy,
} from "@workspace/db"
import type { StoredMessage } from "../src/conversations.ts"
import worker from "../src/index.ts"
import { createOrg } from "../src/org.ts"
import { type CookieOptions, cookieHeader, env } from "./sealed-session.ts"

/**
 * An owner with a real org and a stand-in orchestrator, for the owner-route
 * suites. The org is made by the signup writer itself, so it carries the
 * starting team and a membership the session resolves through. Rows stay
 * behind: `events` is append-only, so nothing here can delete an org that
 * logged one. Every name is fictional.
 */

export const SUFFIX = "-stg.remeai.co.uk"

const noted = (error: unknown) => console.error("waitUntil", error)
const ctx = {
  waitUntil: (promise: Promise<unknown>) => void promise.catch(noted),
} as ExecutionContext

/** The binding, recording every request it is sent. */
export function stubOrchestrator(
  answer: (request: Request) => Response | Promise<Response> = () =>
    Response.json(
      {
        class: "validation",
        code: "stub.refused",
        message: "The stand-in orchestrator refuses everything.",
        detail: {},
        occurred_at: new Date().toISOString(),
      },
      { status: 409 }
    )
) {
  const calls: { request: Request; body: unknown }[] = []
  return {
    calls,
    fetch: async (request: Request) => {
      const body = request.body ? await request.clone().json() : undefined
      calls.push({ request, body })
      return answer(request)
    },
  }
}

export type Stub = ReturnType<typeof stubOrchestrator>

/** A signed-up org and a way to call the API as its owner. */
export async function owner(
  kit: Tenancy,
  url: string,
  tag: string,
  newId?: () => string
) {
  const run = crypto.randomUUID().slice(0, 8)
  const workosUserId = `user_probe_${tag}_${run}`
  const workosOrganizationId = `org_probe_${tag}_${run}`
  const org = await createOrg(
    kit,
    {
      createOrganization: async () => ({ id: workosOrganizationId }),
      listOrganizationMemberships: async () => ({ data: [] }),
      createOrganizationMembership: async () => ({ id: `om_${run}` }),
    },
    {
      name: `Owner probe ${tag} (fixture)`,
      idempotencyKey: run,
      workosUserId,
      email: `${tag}-${run}@owner-probe.invalid`,
      displayName: "Probe Owner",
    },
    newId
  )
  const orgId = org.org_id
  const [dev, chief] = await kit.withOrg({ orgId }, async (db) =>
    Promise.all(
      ["DEV-001", "COS-001"].map(async (code) => {
        const [row] = await db
          .select({ id: staff.id })
          .from(staff)
          .where(eq(staff.staffCode, code))
        return row?.id as string
      })
    )
  )
  const call = async (
    stub: Stub,
    path: string,
    init: RequestInit & {
      cookie?: CookieOptions
      /** Bindings beside the database and the orchestrator, such as `SITES`. */
      bindings?: Record<string, unknown>
    } = {}
  ) => {
    const { cookie, headers, bindings, ...rest } = init
    const session = await cookieHeader(
      { sub: workosUserId, org_id: workosOrganizationId, role: "owner" },
      cookie
    )
    return worker.fetch(
      new Request(`http://api.invalid${path}`, {
        ...rest,
        headers: { ...session, ...(headers as Record<string, string>) },
      }),
      {
        ...env(url),
        ORCHESTRATOR: stub,
        SITE_HOST_SUFFIX: SUFFIX,
        ...bindings,
      } as unknown as Env,
      ctx
    )
  }
  return {
    orgId,
    slug: org.slug,
    name: org.name,
    workosUserId,
    devId: dev as string,
    chiefId: chief as string,
    call,
  }
}

export type Owner = Awaited<ReturnType<typeof owner>>

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/** A ULID for `at`, which the event log's checks and ordering need. */
export function ulid(at = Date.now()): string {
  let time = ""
  for (let t = at, i = 0; i < 10; i++, t = Math.floor(t / 32)) {
    time = B32[t % 32] + time
  }
  let random = ""
  for (let i = 0; i < 16; i++) random += B32[Math.floor(Math.random() * 32)]
  return time + random
}

/** Rows written the way the orchestrator writes them, through `withOrg`. */
export function seed(kit: Tenancy, who: Owner) {
  const { orgId } = who
  return {
    assignment: (
      state: AssignmentState,
      extra: { key?: string; kind?: string } = {}
    ) =>
      kit.withOrg({ orgId }, async (db) => {
        const [row] = await db
          .insert(assignments)
          .values({
            orgId,
            staffId: who.devId,
            createdByStaffId: who.chiefId,
            kind: extra.kind ?? "site.build",
            state,
            goal: "Build the site from the canonical facts.",
            acceptanceCriteria: ["probe"],
            factSnapshotId: crypto.randomUUID(),
            budgetUsd: 5,
            idempotencyKey: extra.key ?? crypto.randomUUID(),
          })
          .returning({ id: assignments.id })
        return row?.id as string
      }),
    state: (id: string, state: AssignmentState) =>
      kit.withOrg({ orgId }, (db) =>
        db
          .update(assignments)
          .set({ state, updatedAt: new Date() })
          .where(eq(assignments.id, id))
      ),
    /** A `null` version is a report the gates refused, still `building`. */
    revision: (assignmentId: string, version: number | null) =>
      kit.withOrg({ orgId }, async (db) => {
        const id = crypto.randomUUID()
        await db.insert(siteRevisions).values({
          id,
          orgId,
          siteId: orgId,
          assignmentId,
          version,
          sourceKey: `sites/${orgId}/${id}/source`,
          artifactPrefix: `sites/${orgId}/${id}/`,
          manifestKey: `sites/${orgId}/${id}/manifest.json`,
          status: version === null ? "building" : "preview",
        })
        return id
      }),
    approval: (
      assignmentId: string,
      revisionId: string,
      hours: number,
      decided = false
    ) =>
      kit.withOrg({ orgId }, async (db) => {
        const id = crypto.randomUUID()
        const now = new Date()
        const expiresAt = new Date(now.getTime() + hours * 3_600_000)
        await db.insert(approvals).values({
          id,
          orgId,
          assignmentId,
          requestedByStaffId: who.chiefId,
          approverStaffId: who.chiefId,
          actionKind: "site.publish",
          target: { kind: "revision", revision_id: revisionId },
          revisionId,
          rationale: "The preview passed every gate.",
          // The 72 hours `requestReview` gives, ending `hours` from now.
          requestedAt: new Date(expiresAt.getTime() - 72 * 3_600_000),
          expiresAt,
          ...(decided
            ? {
                decision: "approved" as const,
                decidedBy: { kind: "console" },
                decidedAt: now,
              }
            : {}),
        })
        return id
      }),
    deployment: (revisionId: string, approvalId: string) =>
      kit.withOrg({ orgId }, (db) =>
        db.insert(deployments).values({
          orgId,
          siteId: orgId,
          revisionId,
          configVersion: 1,
          kind: "publish",
          approvalId,
        })
      ),
    event: (
      assignmentId: string,
      type: string,
      payload: Record<string, unknown>,
      hoursAgo = 0
    ) =>
      kit.withOrg({ orgId }, async (db) => {
        const at = Date.now() - hoursAgo * 3_600_000
        const eventId = ulid(at)
        await db.insert(events).values({
          eventId,
          orgId,
          assignmentId,
          type,
          occurredAt: new Date(at),
          idempotencyKey: ulid(),
          payload,
        })
        return eventId
      }),
    /**
     * A transition as `advance` writes it: the state change event, the
     * transition row citing it, and the assignment's row at the new state and
     * version. `extra` is the event's payload beyond from, to and version, as
     * `request_id` for a block on a question; `reason` is the row's.
     */
    async transition(
      assignmentId: string,
      from: AssignmentState,
      to: AssignmentState,
      version: number,
      extra: Record<string, unknown> = {},
      reason: string | null = null
    ) {
      const eventId = await this.event(
        assignmentId,
        "assignment.state_changed",
        {
          from,
          to,
          version,
          ...extra,
        }
      )
      await kit.withOrg({ orgId }, async (db) => {
        await db.insert(assignmentTransitions).values({
          orgId,
          assignmentId,
          fromState: from,
          toState: to,
          version,
          eventId,
          reason,
        })
        await db
          .update(assignments)
          .set({ state: to, version, updatedAt: new Date() })
          .where(eq(assignments.id, assignmentId))
      })
    },
    /** Messages stored in the order given, so `seq` follows it. */
    messages: (conversationId: string, list: StoredMessage[]) =>
      kit.withOrg({ orgId }, async (db) => {
        for (const message of list) {
          await db.insert(conversationMessages).values({
            conversationId,
            id: message.id,
            orgId,
            parentId: message.parent_id,
            format: message.format,
            content: message.content,
          })
        }
      }),
    /** A block on the question `requestId`, as the Workflow's ask step logs it. */
    blocked(assignmentId: string, requestId: string, version: number) {
      return this.transition(
        assignmentId,
        "implementing",
        "blocked_on_information",
        version,
        { request_id: requestId }
      )
    },
  }
}

/** An `InformationRequest` payload for a build. */
export const question = (
  who: Owner,
  assignmentId: string,
  field = "business.phone"
) => ({
  request_id: crypto.randomUUID(),
  org_id: who.orgId,
  assignment_id: assignmentId,
  requested_by_staff_id: who.devId,
  field,
  why: "The contact section shows it.",
  answer_schema: { type: "object" },
  options: null,
  blocking: true,
  requested_at: new Date().toISOString(),
  expires_at: null,
})
