import { eq } from "drizzle-orm"
import { clearOrgs } from "../fixtures/seed.ts"
import { connect } from "../src/client.ts"
import {
  approvals,
  assignments,
  assignmentTransitions,
  conversationMessages,
  conversations,
  deliveries,
  departments,
  deployments,
  domains,
  events,
  facts,
  jobRuns,
  memberships,
  orgs,
  pushSubscriptions,
  reminders,
  roles,
  scheduledJobs,
  searchConnections,
  searchDaily,
  searchProperties,
  searchSnapshot,
  searchUrlStatus,
  siteRevisions,
  staff,
  staffEvents,
  users,
} from "../src/schema.ts"

/**
 * Two orgs with a row in every tenant table, plus one platform-level role
 * template that belongs to neither.
 *
 * Written through the migrator connection, which holds BYPASSRLS, so the
 * fixtures exist regardless of the policies the suite is about to test. They
 * are clearly fictional (R8) and they are not the golden orgs: `brightclean`,
 * `mopandbucket` and `emptyco` land with the seed story and are shared with the
 * UI and the evals. These exist to be denied.
 *
 * When a tenant table is added, add its rows here. The suite fails on a table
 * that has no row for org A, because cross-org denial against an empty table
 * proves nothing.
 */

const uuid = (n: number) =>
  `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`

export const ORG_A = uuid(1)
export const ORG_B = uuid(2)
/** An org id that is never inserted. Used to probe WITH CHECK on `orgs`. */
export const ORG_ABSENT = uuid(3)

const per = (org: "a" | "b", n: number) =>
  `00000000-0000-4000-${org === "a" ? "a" : "b"}000-${String(n).padStart(12, "0")}`

/** ULIDs are 26 chars of Crockford base32; the check constraint enforces it. */
const ulid = (org: "a" | "b", n: number) =>
  `01K3TENANCY${org.toUpperCase()}${String(n).padStart(14, "0")}`

const PLATFORM_ROLE = uuid(9)

/** The connected domain each org holds live, and org A's one still awaiting DNS. */
export const DOMAIN_OF = {
  a: "tenancy-probe-a.example.com",
  b: "tenancy-probe-b.example.com",
} as const
export const DOMAIN_PENDING = "pending.tenancy-probe-a.example.com"

/** The Search Console property each org holds, as Google names it. */
export const SEARCH_URL_OF = {
  a: "https://tenancy-probe-a.example.com/",
  b: "https://tenancy-probe-b.example.com/",
} as const

/**
 * One person per org, in the platform `users` table. Exported because the
 * suite's platform-table probe names the row it expects each org to see and
 * the row it must not: a global table has no `org_id` to filter on, so the
 * denial has to be written as an id.
 */
export const USER_OF = { a: per("a", 1), b: per("b", 1) } as const

/**
 * The vendor ids the org resolver joins on. Exported for the same reason as
 * `USER_OF`: the refusal the suite drives is one org's person against the other
 * org's WorkOS id, and both halves have to be nameable from the test.
 */
export const WORKOS_USER_OF = {
  a: "user_tenancy_a",
  b: "user_tenancy_b",
} as const

export const WORKOS_ORG_OF = {
  a: "org_tenancy_a",
  b: "org_tenancy_b",
} as const

/**
 * A person who holds a membership in org A that is not active. ADR-029 makes
 * the resolver refuse one, and a refusal with nobody in that state to refuse is
 * an assertion about nothing.
 */
export const USER_PENDING = per("a", 8)
export const WORKOS_USER_PENDING = "user_tenancy_pending"

export async function seedTwoOrgs() {
  // Clearing first rather than repeating the delete list: two copies of a
  // dependency-ordered list drift, and the copy that drifts is the one nobody
  // reads.
  await clearTwoOrgs()
  const { sql, db } = connect()

  await db.insert(orgs).values([
    {
      id: ORG_A,
      slug: "tenancy-probe-a",
      name: "Tenancy Probe A",
      workosOrganizationId: WORKOS_ORG_OF.a,
    },
    {
      id: ORG_B,
      slug: "tenancy-probe-b",
      name: "Tenancy Probe B",
      workosOrganizationId: WORKOS_ORG_OF.b,
    },
  ])

  // org_id NULL: the platform template every org may read and none may write.
  await db.insert(roles).values({
    id: PLATFORM_ROLE,
    key: "chief_of_staff",
    title: "Chief of Staff",
  })

  // Somebody in org A whose membership never went active.
  await db.insert(users).values({
    id: USER_PENDING,
    workosUserId: WORKOS_USER_PENDING,
    email: "pending@tenancy-probe-a.invalid",
    name: "Tenancy Probe Invitee",
  })
  await db.insert(memberships).values({
    id: per("a", 9),
    orgId: ORG_A,
    userId: USER_PENDING,
    workosMembershipId: "om_tenancy_pending",
    role: "member",
    status: "pending",
  })

  for (const [tag, org] of [
    ["a", ORG_A],
    ["b", ORG_B],
  ] as const) {
    // A person, then their membership. `users` is a platform table now, so the
    // row itself belongs to nobody and the membership is what puts them in an
    // org (ADR-028).
    await db.insert(users).values({
      id: USER_OF[tag],
      workosUserId: WORKOS_USER_OF[tag],
      email: `owner@tenancy-probe-${tag}.invalid`,
      name: "Tenancy Probe Owner",
    })
    await db.insert(memberships).values({
      id: per(tag, 7),
      orgId: org,
      userId: USER_OF[tag],
      workosMembershipId: `om_tenancy_${tag}`,
      role: "owner",
      status: "active",
    })
    await db.insert(roles).values({
      id: per(tag, 2),
      orgId: org,
      key: "chief_of_staff",
      title: "Chief of Staff",
    })
    await db.insert(departments).values({
      id: per(tag, 3),
      orgId: org,
      name: "Operations",
    })
    await db.insert(staff).values({
      id: per(tag, 4),
      orgId: org,
      staffCode: "OWN-001",
      displayName: "Tenancy Probe Owner",
      kind: "human",
      userId: USER_OF[tag],
      status: "active",
    })
    await db.insert(facts).values({
      id: per(tag, 5),
      orgId: org,
      key: "tenancy.probe",
      factType: "probe",
      value: { probe: true },
      provenanceSource: "owner_stated",
      provenanceConfidence: 1,
    })
    await db.insert(staffEvents).values({
      id: per(tag, 6),
      orgId: org,
      staffId: per(tag, 4),
      kind: "hired",
    })
    await db.insert(events).values({
      eventId: ulid(tag, 1),
      orgId: org,
      staffId: per(tag, 4),
      // A lifecycle event belongs to no session, so it carries no seq
      // (ADR-028). The check constraint refuses the other three combinations.
      sessionId: null,
      seq: null,
      type: "staff.hired",
      occurredAt: new Date(),
      idempotencyKey: ulid(tag, 2),
    })
    // The builder track's rows: an assignment, the event its one transition
    // wrote, the transition citing that event, and a revision of the site.
    await db.insert(assignments).values({
      id: per(tag, 10),
      orgId: org,
      staffId: per(tag, 4),
      createdByStaffId: per(tag, 4),
      kind: "site.build",
      state: "briefing",
      version: 1,
      goal: "Tenancy probe",
      acceptanceCriteria: ["probe"],
      factSnapshotId: per(tag, 5),
      budgetUsd: 1,
      idempotencyKey: ulid(tag, 4),
    })
    await db.insert(events).values({
      eventId: ulid(tag, 3),
      orgId: org,
      staffId: per(tag, 4),
      assignmentId: per(tag, 10),
      sessionId: null,
      seq: null,
      type: "assignment.state_changed",
      occurredAt: new Date(),
      idempotencyKey: ulid(tag, 5),
      payload: { from: "queued", to: "briefing", version: 1 },
    })
    await db.insert(assignmentTransitions).values({
      id: per(tag, 11),
      orgId: org,
      assignmentId: per(tag, 10),
      fromState: "queued",
      toState: "briefing",
      version: 1,
      eventId: ulid(tag, 3),
    })
    await db.insert(siteRevisions).values({
      id: per(tag, 12),
      orgId: org,
      siteId: org,
      assignmentId: per(tag, 10),
      version: 1,
      sourceKey: `sites/${org}/${per(tag, 12)}/source.tar.zst`,
      artifactPrefix: `sites/${org}/${per(tag, 12)}/dist/`,
      manifestKey: `sites/${org}/${per(tag, 12)}/manifest.json`,
    })
    // The approval that published that revision, and the deployment it made.
    await db.insert(approvals).values({
      id: per(tag, 13),
      orgId: org,
      assignmentId: per(tag, 10),
      requestedByStaffId: per(tag, 4),
      approverStaffId: per(tag, 4),
      actionKind: "site.publish",
      target: { kind: "revision", revision_id: per(tag, 12) },
      revisionId: per(tag, 12),
      rationale: "Tenancy probe",
      requestedAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 3_600_000),
      decision: "approved",
      decidedBy: { kind: "console" },
      decidedAt: new Date(),
    })
    await db.insert(deployments).values({
      id: per(tag, 14),
      orgId: org,
      siteId: org,
      revisionId: per(tag, 12),
      configVersion: 1,
      kind: "publish",
      approvalId: per(tag, 13),
    })
    // The owner's conversation, and a question and its answer in it.
    await db.insert(conversations).values({
      id: per(tag, 15),
      orgId: org,
      kind: "assistant",
      title: "Tenancy probe",
      createdByStaffId: per(tag, 4),
      idempotencyKey: `__LOCALID_tenancy_${tag}`,
    })
    await db.insert(conversationMessages).values([
      {
        conversationId: per(tag, 15),
        id: "probe_user_1",
        orgId: org,
        parentId: null,
        format: "ai-sdk/v6",
        content: { role: "user", parts: [{ type: "text", text: "Probe" }] },
      },
      {
        conversationId: per(tag, 15),
        id: "probe_assistant_1",
        orgId: org,
        parentId: "probe_user_1",
        format: "ai-sdk/v6",
        content: {
          role: "assistant",
          parts: [{ type: "text", text: "Probe" }],
        },
      },
    ])
    // A reminder the assistant made in that conversation.
    await db.insert(reminders).values({
      id: per(tag, 16),
      orgId: org,
      title: "Tenancy probe",
      source: "assistant",
      conversationId: per(tag, 15),
      createdByStaffId: per(tag, 4),
      idempotencyKey: `tenancy_reminder_${tag}`,
    })
    // A job for that reminder, not due for a year so the claim never takes it,
    // with its one run and the delivery that run made.
    await db.insert(scheduledJobs).values({
      id: per(tag, 20),
      orgId: org,
      kind: "reminder",
      refId: per(tag, 16),
      nextRunAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    })
    await db.insert(jobRuns).values({
      jobId: per(tag, 20),
      orgId: org,
      runAt: new Date("2026-10-15T09:00:00Z"),
      outcome: "ok",
    })
    await db.insert(deliveries).values({
      orgId: org,
      key: `tenancy_delivery_${tag}`,
      channel: "in_app",
    })
    await db.insert(pushSubscriptions).values({
      orgId: org,
      staffId: per(tag, 4),
      endpoint: `https://push.example.test/tenancy-${tag}`,
      p256dh: "tenancy-p256dh",
      auth: "tenancy-auth",
    })
    // The org's connected domain: live, served on its apex (org A on `www.`).
    await db.insert(domains).values({
      id: per(tag, 17),
      orgId: org,
      siteId: org,
      name: DOMAIN_OF[tag],
      primaryHost: tag === "a" ? `www.${DOMAIN_OF[tag]}` : DOMAIN_OF[tag],
      origin: "connected",
      method: "records",
      state: "active",
      approvalId: per(tag, 13),
      activatedAt: new Date(),
    })
    // Its Google connection, the property it verified, and a row of each report.
    await db.insert(searchConnections).values({
      orgId: org,
      connectedByUserId: USER_OF[tag],
      googleEmail: `owner@tenancy-probe-${tag}.invalid`,
      refreshToken: "v1.iv.ct",
      scopes: ["webmasters"],
      state: "active",
      connectedAt: new Date(),
    })
    await db.insert(searchProperties).values({
      id: per(tag, 19),
      orgId: org,
      host: DOMAIN_OF[tag],
      siteUrl: SEARCH_URL_OF[tag],
      kind: "url_prefix",
      method: "file",
      state: "verified",
      verifiedAt: new Date(),
    })
    const property = { orgId: org, propertyId: per(tag, 19) }
    const stats = { clicks: 3, impressions: 40, ctr: 0.075, position: 7.5 }
    await db
      .insert(searchDaily)
      .values({ ...property, date: "2026-10-15", ...stats })
    await db.insert(searchSnapshot).values({
      ...property,
      query: "tenancy probe",
      page: SEARCH_URL_OF[tag],
      windowEnd: "2026-10-15",
      ...stats,
    })
    await db.insert(searchUrlStatus).values({
      ...property,
      url: SEARCH_URL_OF[tag],
      verdict: "PASS",
      inspectedAt: new Date(),
    })
  }
  // A connect still waiting on DNS: the definer must not answer for it.
  await db.insert(domains).values({
    id: per("a", 18),
    orgId: ORG_A,
    siteId: ORG_A,
    name: DOMAIN_PENDING,
    primaryHost: DOMAIN_PENDING,
    origin: "connected",
    method: "records",
    state: "awaiting_dns",
  })
  await sql.end()
}

/**
 * Removes both probe orgs. Safe to run on a database that never had them, and
 * safe to run twice, which is what makes `seedTwoOrgs` able to open with it.
 *
 * One transaction, and that is the fix for a real flake rather than tidiness.
 * The deletes take about four seconds against Neon warm and longer against a
 * suspended compute, while vitest's default hook timeout is ten. As eight
 * separate statements, an `afterAll` that ran over left some tables cleared and
 * some not, and the next run's `beforeAll` walked into a foreign key it could
 * not satisfy. As one transaction it either all lands or none of it does, and
 * the caller sees the error either way. `rls.test.ts` also gives the hook the
 * same 60 s the seed has.
 *
 * The dependency-ordered deletes are `clearOrgs`, shared with the golden seed
 * rather than written out a second time here: two hand-maintained copies of
 * that order drift, and the copy that drifts is the one nobody reads. The
 * platform role template belongs to no org, so it is the one delete this file
 * still owns.
 */
export async function clearTwoOrgs() {
  const { sql, db } = connect()
  try {
    await db.transaction(async (tx) => {
      await clearOrgs(tx, [ORG_A, ORG_B], [USER_OF.a, USER_OF.b, USER_PENDING])
      await tx.delete(roles).where(eq(roles.id, PLATFORM_ROLE))
    })
  } finally {
    await sql.end()
  }
}
