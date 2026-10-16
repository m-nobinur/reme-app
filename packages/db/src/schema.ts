import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  char,
  check,
  customType,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

/**
 * `jsonb`, written the way drizzle's own is and read without a second parse.
 * postgres.js already parses a jsonb column before drizzle sees it, and
 * drizzle's `jsonb` then `JSON.parse`s any string it is handed, so a fact
 * stated as "123" or "[1,2]" came back as a number or an array. The stored
 * value was always right; only the read was wrong.
 */
const jsonb = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => "jsonb",
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (value) => value,
})

/**
 * The core schema (§5.2 staff entity model, §10.1 stores 1 and 6).
 *
 * Two rules shape every table here and neither can be retrofitted cheaply:
 *
 * 1. Every tenant-scoped table carries `org_id` as its first column after the
 *    key, so the RLS policies that land next are a policy per table and not a
 *    schema rewrite. `orgs` is the tenant root and scopes on `id`.
 * 2. A row may not reference a row in another org. `org_id` travels inside
 *    every foreign key that stays inside the tenant boundary, so a cross-org
 *    reference is rejected by Postgres rather than by application code that
 *    someone can forget to call.
 *
 * Column shapes that also exist in `packages/contracts` are reconciled there,
 * not here: see `src/map.ts` and `test/contract-alignment.test.ts`.
 */

/** §5.2. A staff member is an org record; humans occupy the same tree later. */
export const staffKind = pgEnum("staff_kind", ["agent", "human"])

/** §5.4 lifecycle. `suspended` is reachable from active or paused by policy. */
export const staffStatus = pgEnum("staff_status", [
  "draft",
  "onboarding",
  "active",
  "paused",
  "suspended",
  "offboarding",
  "archived",
])

/** §5.4. The transitions that fan out consequences, as a log. */
export const staffEventKind = pgEnum("staff_event_kind", [
  "hired",
  "configured",
  "paused",
  "resumed",
  "reassigned",
  "evaluated",
  "offboarded",
  "credential_revoked",
])

/** §10.2, and `FactProvenance.source`. `inferred` never reaches a tenant. */
export const factSource = pgEnum("fact_source", [
  "owner_stated",
  "document",
  "integration",
  "inferred",
])

/** §28.3, and `TaintLabel`. Travels with the event, not beside it. */
export const taintLabel = pgEnum("taint_label", [
  "untrusted_input",
  "external_content",
  "inferred",
  "quarantined",
])

/**
 * The tenant boundary (§9.2, layer 2). Every policy below reads the org id out
 * of `app.org_id`, which `withOrg` sets transaction-locally and nothing else
 * sets at all.
 *
 * `current_setting(..., true)` returns NULL when the GUC was never set, and
 * `nullif` turns an empty string into NULL too, so a query with no org context
 * compares against NULL, matches nothing, and is denied. Fail-closed is the
 * resting state rather than a case someone has to remember.
 *
 * Policies apply `to public`, which is every role except one holding BYPASSRLS.
 * The migrator holds it; `reme_app`, which `withOrg` switches to for the length
 * of the transaction, does not. That is the whole enforcement.
 */
const currentOrg = () =>
  sql`nullif(current_setting('app.org_id', true), '')::uuid`

/**
 * The signed-in person, for the two policies that cannot be answered by an org
 * (ADR-028). `withOrg` sets it transaction-locally beside `app.org_id`, from
 * the sealed session and never from client input, and an unset one reads as
 * NULL and matches nothing.
 */
const currentWorkosUser = () =>
  sql`nullif(current_setting('app.workos_user_id', true), '')`

/** The standard policy: rows belong to the current org, reads and writes both. */
const orgIsolation = (table: string) =>
  pgPolicy(`${table}_org_isolation`, {
    for: "all",
    to: "public",
    using: sql`org_id = ${currentOrg()}`,
    withCheck: sql`org_id = ${currentOrg()}`,
  })

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow()

const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow()
  .$onUpdate(() => new Date())

/** The tenant root. Everything else is scoped to one of these. */
export const orgs = pgTable(
  "orgs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Stable handle used by fixtures, seeds and dev URLs. */
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    /**
     * The WorkOS organization this org mirrors (ADR-029). Nullable, because an
     * org can exist before one does: the fixtures, the seeds and the evals all
     * make orgs that no identity provider has ever heard of, and a column they
     * cannot fill would be a column they had to invent a value for.
     *
     * Unique, because it is the join key `resolve_org` reads. Two rows claiming
     * the same WorkOS organization would make "which org is this person in"
     * ambiguous, and the resolver would answer either one.
     *
     * Our `id` stays ours. It is not derived from this value and does not
     * change when this value does, so the vendor id is a lookup key rather than
     * a primary key wearing a disguise.
     */
    workosOrganizationId: text("workos_organization_id"),
    /** The org's one Stripe Customer, made on its first domain purchase. */
    stripeCustomerId: text("stripe_customer_id"),
    createdAt,
    updatedAt,
  },
  (t) => [
    unique("orgs_workos_organization_key").on(t.workosOrganizationId),
    unique("orgs_stripe_customer_key").on(t.stripeCustomerId),
    // The tenant root carries no org_id: it scopes on its own key.
    pgPolicy("orgs_org_isolation", {
      for: "all",
      to: "public",
      using: sql`id = ${currentOrg()}`,
      withCheck: sql`id = ${currentOrg()}`,
    }),
  ]
)

/**
 * Owners and operators, mirrored from WorkOS (DR-4). Tenant end-customers are
 * a different population in Better Auth tables and do not belong here.
 *
 * The one table in the schema with no `org_id`, and the only entry in the
 * tenancy suite's `PLATFORM_TABLES` (ADR-028). The mirror takes the grain of
 * the system it mirrors: a WorkOS `User` holds no organization reference and
 * `OrganizationMembership` is the join, so a person is one row here however
 * many orgs they work in, and `memberships` below carries the org. A
 * `user.updated` webhook arrives with a user id and no organization, which the
 * per-org shape could answer only by bypassing RLS or by writing one
 * transaction per org and leaving two orgs disagreeing when one half failed.
 *
 * `email` carries a plain unique rather than one on `lower(email)`: WorkOS
 * folds case on store and refuses a second user at an address that already
 * exists, checked against staging 2026-08-28, so the mirror only ever receives
 * folded addresses.
 *
 * Being outside the tenant boundary is not being outside RLS. An org sees
 * exactly the people it holds a membership for, and the only writes are a
 * person mirroring themselves at sign-in.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workosUserId: text("workos_user_id").notNull(),
    email: text("email").notNull(),
    name: text("name"),
    createdAt,
    updatedAt,
  },
  (t) => [
    // Their primary key, and what a webhook arrives holding, so this is both
    // the join key and the sign-in lookup: the unique index serves both and the
    // separate hot-path index the per-org shape needed is gone with it.
    unique("users_workos_user_key").on(t.workosUserId),
    unique("users_email_key").on(t.email),
    // The org test is written out rather than left to compose through the
    // memberships policy, so this USING names `app.org_id` itself and the
    // guarantee does not depend on a second table's policy staying as it is.
    pgPolicy("users_member_read", {
      for: "select",
      to: "public",
      using: sql`exists (
        select 1 from memberships m
        where m.user_id = users.id and m.org_id = ${currentOrg()}
      )`,
    }),
    // A person may read their own row, membership or not. Without it the org
    // writer cannot work: `insert ... on conflict ... returning id` applies the
    // SELECT policies to the row it returns, and at that moment the membership
    // that `users_member_read` looks for does not exist yet, because the
    // membership is the next statement and references the id this one returns.
    // It widens nothing across a tenant boundary: the id it keys on comes from
    // the sealed session and names one person.
    pgPolicy("users_self_read", {
      for: "select",
      to: "public",
      using: sql`workos_user_id = ${currentWorkosUser()}`,
    }),
    // Sign-in mirrors the person signing in and nobody else. A
    // membership-derived write policy cannot work here: the membership
    // references the user, so at sign-up the user row has to exist before any
    // membership can vouch for it.
    pgPolicy("users_self_insert", {
      for: "insert",
      to: "public",
      withCheck: sql`workos_user_id = ${currentWorkosUser()}`,
    }),
    pgPolicy("users_self_update", {
      for: "update",
      to: "public",
      using: sql`workos_user_id = ${currentWorkosUser()}`,
      withCheck: sql`workos_user_id = ${currentWorkosUser()}`,
    }),
    // No delete policy. Removing a person is the deletion workflow in §10.5 and
    // runs as the migrator.
  ]
)

/**
 * The join, and the tenant table (ADR-028). A person leaving an org sets
 * `status = 'inactive'` and is never hard-deleted, because §5.4 keeps the staff
 * row for the life of the org and `staff_user_fk` is `no action`.
 *
 * `role` and `status` mirror WorkOS: `RoleResponse.slug`, and one of `active`,
 * `inactive` or `pending`. Neither is an enum here, because the set is theirs
 * to extend and a mirror that refuses a value the source already holds drops
 * the row instead of the value.
 */
export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    workosMembershipId: text("workos_membership_id").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull(),
    createdAt,
    updatedAt,
  },
  (t) => [
    unique("memberships_workos_membership_key").on(t.workosMembershipId),
    // What `staff_user_fk` points at, so a human staff row can only name a
    // person who holds a membership in the same org.
    unique("memberships_org_user_key").on(t.orgId, t.userId),
    unique("memberships_org_membership_key").on(t.orgId, t.id),
    orgIsolation("memberships"),
  ]
)

/**
 * §5.3. A NULL `org_id` is a platform-defined template; a non-NULL one is an
 * org override. Role versions are immutable once referenced: publish a new
 * version and migrate staff deliberately, never mutate one in place.
 */
export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").references(() => orgs.id),
    key: text("key").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    defaultCapabilities: jsonb("default_capabilities")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    defaultRuntimeProfile: jsonb("default_runtime_profile")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    version: integer("version").notNull().default(1),
    createdAt,
  },
  (t) => [
    // NULLS NOT DISTINCT, or two platform templates could share a key and a
    // version, which is the one thing this constraint exists to stop.
    unique("roles_org_key_version_key")
      .on(t.orgId, t.key, t.version)
      .nullsNotDistinct(),
    check("roles_version_positive", sql`version > 0`),
    // The one table whose `org_id` is nullable, so the one policy that is not
    // the standard equality. A NULL means a platform-defined template and every
    // org reads it; nothing else here is lenient.
    pgPolicy("roles_org_read", {
      for: "select",
      to: "public",
      using: sql`org_id is null or org_id = ${currentOrg()}`,
    }),
    // Split from the read on purpose. A single `for all` policy would let a
    // tenant DELETE a platform template, because DELETE is checked against
    // USING and has no WITH CHECK to stop it, and would let one INSERT a
    // template too. Writes see equality only.
    pgPolicy("roles_org_write", {
      for: "all",
      to: "public",
      using: sql`org_id = ${currentOrg()}`,
      withCheck: sql`org_id = ${currentOrg()}`,
    }),
  ]
)

/** §5.2. A tree per org; `parent_id` may not cross the org boundary. */
export const departments = pgTable(
  "departments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    name: text("name").notNull(),
    parentId: uuid("parent_id"),
    createdAt,
    updatedAt,
  },
  (t) => [
    unique("departments_id_org_key").on(t.id, t.orgId),
    unique("departments_org_name_key").on(t.orgId, t.name),
    foreignKey({
      name: "departments_parent_fk",
      columns: [t.parentId, t.orgId],
      foreignColumns: [t.id, t.orgId],
    }),
    orgIsolation("departments"),
  ]
)

/**
 * §5.2, the spine of the product. Nothing agent-specific lives here: agent
 * detail hangs off an `agent_profile` extension in a later story, and a human
 * is the same row with `kind = 'human'` and a `user_id`.
 */
export const staff = pgTable(
  "staff",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    /** Human-readable, e.g. `COS-001`. Unique per org, never reused. */
    staffCode: text("staff_code").notNull(),
    displayName: text("display_name").notNull(),
    kind: staffKind("kind").notNull(),
    /** Set only for `kind = 'human'`; the person's membership in this org. */
    userId: uuid("user_id"),
    roleId: uuid("role_id").references(() => roles.id),
    departmentId: uuid("department_id"),
    /** Reporting line. NULL only for the org root, the owner's proxy record. */
    managerId: uuid("manager_id"),
    positionTitle: text("position_title"),
    status: staffStatus("status").notNull().default("draft"),
    createdAt,
    updatedAt,
  },
  (t) => [
    unique("staff_id_org_key").on(t.id, t.orgId),
    unique("staff_org_code_key").on(t.orgId, t.staffCode),
    foreignKey({
      name: "staff_manager_fk",
      columns: [t.managerId, t.orgId],
      foreignColumns: [t.id, t.orgId],
    }),
    foreignKey({
      name: "staff_department_fk",
      columns: [t.departmentId, t.orgId],
      foreignColumns: [departments.id, departments.orgId],
    }),
    // Into `memberships`, not `users`: a person is global and a membership is
    // what makes them part of this org, so this is the constraint that keeps a
    // human staff row from naming somebody who does not work here. MATCH
    // SIMPLE, so a null `user_id` skips the check, which is what an agent staff
    // row wants.
    foreignKey({
      name: "staff_user_fk",
      columns: [t.orgId, t.userId],
      foreignColumns: [memberships.orgId, memberships.userId],
    }),
    // Exactly one root per org (§5.2). Single-parent comes from the column
    // being scalar; the no-cycles check needs a constraint trigger and lands
    // with the first endpoint that can write a reporting line.
    uniqueIndex("staff_one_root_per_org")
      .on(t.orgId)
      .where(sql`manager_id is null`),
    index("staff_org_manager_idx").on(t.orgId, t.managerId),
    orgIsolation("staff"),
  ]
)

/**
 * Store 1 (§10.1). Versioned and never overwritten: superseding a fact closes
 * the losing version with `valid_to` and writes a new row. Provenance is
 * flattened into columns rather than kept as the contract's nested object, so
 * the source is a database enum and the confidence range is a check
 * constraint; `toFactRecord` in `src/map.ts` re-nests it.
 */
export const facts = pgTable(
  "facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    /** Canonical key, e.g. `hours.tuesday_close`. */
    key: text("key").notNull(),
    /** Domain classification the pack validates `value` against. */
    factType: text("fact_type").notNull(),
    value: jsonb("value").notNull(),
    version: integer("version").notNull().default(1),
    provenanceSource: factSource("provenance_source").notNull(),
    provenanceConfidence: doublePrecision("provenance_confidence").notNull(),
    verifiedByStaffId: uuid("verified_by_staff_id"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    validFrom: timestamp("valid_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    supersededByFactId: uuid("superseded_by_fact_id"),
    createdAt,
    updatedAt,
  },
  (t) => [
    unique("facts_id_org_key").on(t.id, t.orgId),
    unique("facts_org_key_version_key").on(t.orgId, t.key, t.version),
    foreignKey({
      name: "facts_superseded_by_fk",
      columns: [t.supersededByFactId, t.orgId],
      foreignColumns: [t.id, t.orgId],
    }),
    foreignKey({
      name: "facts_verified_by_fk",
      columns: [t.verifiedByStaffId, t.orgId],
      foreignColumns: [staff.id, staff.orgId],
    }),
    // One open-ended version per key. Two rows claiming to be current is the
    // contradiction the whole versioning scheme exists to prevent.
    uniqueIndex("facts_one_current_per_key")
      .on(t.orgId, t.key)
      .where(sql`valid_to is null`),
    check("facts_version_positive", sql`version > 0`),
    check(
      "facts_confidence_range",
      sql`provenance_confidence >= 0 and provenance_confidence <= 1`
    ),
    orgIsolation("facts"),
  ]
)

/**
 * §5.2, append-only. The lifecycle log the staff endpoints read directly;
 * `events` below is the harness log everything else is derived from. Nothing
 * updates or deletes a row here, so there is no `updated_at`.
 */
export const staffEvents = pgTable(
  "staff_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    staffId: uuid("staff_id").notNull(),
    kind: staffEventKind("kind").notNull(),
    /** NULL when the platform acted rather than a staff member. */
    actorStaffId: uuid("actor_staff_id"),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "staff_events_staff_fk",
      columns: [t.staffId, t.orgId],
      foreignColumns: [staff.id, staff.orgId],
    }),
    foreignKey({
      name: "staff_events_actor_fk",
      columns: [t.actorStaffId, t.orgId],
      foreignColumns: [staff.id, staff.orgId],
    }),
    index("staff_events_staff_idx").on(t.orgId, t.staffId, t.occurredAt),
    orgIsolation("staff_events"),
  ]
)

/**
 * Store 6 (§10.1), the event-log skeleton. One row per `EventEnvelope`: this
 * table is the system of record for context derivation (§10.6), so anything
 * that is not appended here is not model-visible (R7).
 *
 * `assignment_id` and `session_id` carry no foreign key yet because neither
 * table exists; they are added as those tables land, which is an expand-only
 * change. Columns are typed and constrained now so that stays true.
 */
export const events = pgTable(
  "events",
  {
    /** The envelope's ULID. Sortable, so it doubles as the append order. */
    eventId: char("event_id", { length: 26 }).primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    staffId: uuid("staff_id"),
    assignmentId: uuid("assignment_id"),
    sessionId: uuid("session_id"),
    /**
     * The position in the session's stream, and NULL for an event that belongs
     * to no session (ADR-028). The aggregate is the session because §10.6
     * replays a session. There is no counter row to serialise on. A runtime
     * session's seq comes from the facade's tee; a conversation's comes from
     * `appendSessionEvent`, which reads the session's last seq inside its own
     * insert. Either way the unique index below refuses a second writer's
     * duplicate, and refusing the out-of-order append §13 asks for is one probe
     * on that same index.
     */
    seq: integer("seq"),
    /** Dotted event key, e.g. `assignment.state_changed`. */
    type: text("type").notNull(),
    /** When it happened, from the producer. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** When we appended it. Clock skew is diagnosable only if both exist. */
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    idempotencyKey: char("idempotency_key", { length: 26 }).notNull(),
    taint: taintLabel("taint").array().notNull().default([]),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [
    foreignKey({
      name: "events_staff_fk",
      columns: [t.staffId, t.orgId],
      foreignColumns: [staff.id, staff.orgId],
    }),
    // R5: a consumer that runs twice upserts onto the same row.
    unique("events_org_idempotency_key").on(t.orgId, t.idempotencyKey),
    // So a row in another table can cite an event and its org in one foreign
    // key, and never an event that belongs to a different tenant.
    unique("events_id_org_key").on(t.eventId, t.orgId),
    // The aggregate replay reads: one seq per session, no gaps to argue about.
    // No WHERE any more, because a row with no session now has no seq either
    // and two of those do not collide: NULLs are distinct in a unique index.
    uniqueIndex("events_session_seq_key").on(t.sessionId, t.seq),
    index("events_org_occurred_idx").on(t.orgId, t.occurredAt),
    // An assignment's stream and its spend: one build writes thousands of
    // rows, most of them deltas, and the cost sum reads only `runtime.turn`.
    index("events_assignment_type_idx").on(t.assignmentId, t.type),
    check("events_seq_nonnegative", sql`seq >= 0`),
    // The same pairing `EventEnvelope` carries, in the place a producer that
    // skips the contract still meets it.
    check(
      "events_seq_pairs_with_session",
      sql`(session_id is null) = (seq is null)`
    ),
    check("events_id_is_ulid", sql`event_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'`),
    check(
      "events_idempotency_key_is_ulid",
      sql`idempotency_key ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'`
    ),
    // `[.]` rather than `\.`, because a lone backslash never survives to SQL:
    // the JavaScript template literal consumes it, before drizzle-kit sees the
    // string at all. `\.` in a `sql` tag reaches Postgres as `.`, which matches
    // any character, so the escaped-looking form silently accepts `staff-hired`
    // as a dotted event type. Write `\\.` or, as here, a character class that
    // needs no escape.
    check(
      "events_type_is_dotted",
      sql`type ~ '^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$'`
    ),
    orgIsolation("events"),
  ]
)

/** The §8.4 state machine. The same sixteen values as the contract's enum. */
export const assignmentState = pgEnum("assignment_state", [
  "queued",
  "briefing",
  "planning",
  "implementing",
  "validating",
  "preview_ready",
  "awaiting_review",
  "revising",
  "release_candidate",
  "published",
  "blocked_on_information",
  "blocked_on_approval",
  "repairing",
  "paused",
  "failed",
  "cancelled",
])

export const assignmentPriority = pgEnum("assignment_priority", [
  "low",
  "normal",
  "high",
  "urgent",
])

/** ADR-031. `published` means activated at least once, never "live now". */
export const siteRevisionStatus = pgEnum("site_revision_status", [
  "building",
  "preview",
  "published",
  "retired",
])

/**
 * `Assignment` (§19), owned by the orchestrator. State truth is this row;
 * Workflows is the executor (§8.4). `version` is the optimistic lock the
 * contract calls `expected_version`: a transition carrying a stale one is
 * refused, and every successful one bumps it and writes a transition row.
 */
export const assignments = pgTable(
  "assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    /** Assignee. A `staff` row, so a human can occupy it unchanged. */
    staffId: uuid("staff_id").notNull(),
    createdByStaffId: uuid("created_by_staff_id").notNull(),
    parentAssignmentId: uuid("parent_assignment_id"),
    revisionOfAssignmentId: uuid("revision_of_assignment_id"),
    /** Dotted, e.g. `site.build`, `site.revise`. */
    kind: text("kind").notNull(),
    state: assignmentState("state").notNull().default("queued"),
    version: integer("version").notNull().default(0),
    goal: text("goal").notNull(),
    acceptanceCriteria: jsonb("acceptance_criteria")
      .$type<string[]>()
      .notNull(),
    factSnapshotId: uuid("fact_snapshot_id").notNull(),
    packRefs: jsonb("pack_refs")
      .$type<{ key: string; version: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    budgetUsd: doublePrecision("budget_usd").notNull(),
    /**
     * Model spend in USD, summed from the assignment's `runtime.turn` events
     * when it reaches a terminal state (§29.2). Null while it is open; the
     * log is the truth and this is the figure frozen at close.
     */
    costUsd: doublePrecision("cost_usd"),
    /**
     * The `Blueprint` the planner wrote and the owner reviews (ADR-038), the
     * latest round's. Null on a build that did not plan: a revise, the quick
     * lane, or a row from before planning. The contract is the check, in the
     * planner; the column is its store, as `acceptance_criteria` is.
     */
    blueprint: jsonb("blueprint"),
    deadline: timestamp("deadline", { withTimezone: true }),
    priority: assignmentPriority("priority").notNull().default("normal"),
    /** The Workflows instance driving this row, once one exists. */
    workflowInstanceId: text("workflow_instance_id"),
    /** §13.1: a duplicate create replays this row rather than making another. */
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt,
    updatedAt,
  },
  (t) => [
    unique("assignments_id_org_key").on(t.id, t.orgId),
    unique("assignments_org_idempotency_key").on(t.orgId, t.idempotencyKey),
    foreignKey({
      name: "assignments_staff_fk",
      columns: [t.staffId, t.orgId],
      foreignColumns: [staff.id, staff.orgId],
    }),
    foreignKey({
      name: "assignments_created_by_fk",
      columns: [t.createdByStaffId, t.orgId],
      foreignColumns: [staff.id, staff.orgId],
    }),
    foreignKey({
      name: "assignments_parent_fk",
      columns: [t.parentAssignmentId, t.orgId],
      foreignColumns: [t.id, t.orgId],
    }),
    foreignKey({
      name: "assignments_revision_of_fk",
      columns: [t.revisionOfAssignmentId, t.orgId],
      foreignColumns: [t.id, t.orgId],
    }),
    // §13: one writing assignment per site. One site per org today, so the
    // key is the org; a second site changes the Assignment contract first
    // (ADR-031). A writer is any site assignment between claim and a terminal
    // state, and `paused` releases the lock so a parked build cannot hold a
    // site for good. The loser stays `queued` (§13's "second assignment
    // queues") and the orchestrator's claim step is what catches the refusal.
    uniqueIndex("assignments_site_writer_key")
      .on(t.orgId)
      .where(
        sql`kind like 'site.%' and state not in ('queued', 'paused', 'published', 'failed', 'cancelled')`
      ),
    check(
      "assignments_kind_is_dotted",
      sql`kind ~ '^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$'`
    ),
    check("assignments_budget_positive", sql`budget_usd > 0`),
    check("assignments_cost_nonnegative", sql`cost_usd >= 0`),
    check("assignments_version_nonnegative", sql`version >= 0`),
    orgIsolation("assignments"),
  ]
)

/**
 * One row per transition, written in the same transaction as the `assignments`
 * update and the event. "No transition without an event" (§8.4) holds by the
 * NOT NULL foreign key here, and the property suite in `apps/orchestrator`
 * proves the event is the right one.
 */
export const assignmentTransitions = pgTable(
  "assignment_transitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    assignmentId: uuid("assignment_id").notNull(),
    fromState: assignmentState("from_state").notNull(),
    toState: assignmentState("to_state").notNull(),
    /** The assignment's `version` after this transition. */
    version: integer("version").notNull(),
    eventId: char("event_id", { length: 26 }).notNull(),
    reason: text("reason"),
    createdAt,
  },
  (t) => [
    foreignKey({
      name: "assignment_transitions_assignment_fk",
      columns: [t.assignmentId, t.orgId],
      foreignColumns: [assignments.id, assignments.orgId],
    }),
    foreignKey({
      name: "assignment_transitions_event_fk",
      columns: [t.eventId, t.orgId],
      foreignColumns: [events.eventId, events.orgId],
    }),
    unique("assignment_transitions_version_key").on(t.assignmentId, t.version),
    // The repair budget (§8.4, at most three) is a count over this index.
    index("assignment_transitions_to_state_idx").on(t.assignmentId, t.toState),
    orgIsolation("assignment_transitions"),
  ]
)

/**
 * `SiteRevision` (ADR-031). `version` is the site's own counter; the `v{n}`
 * tag is derived from it and never stored. It is set when the revision passes
 * the gates, so a refused report keeps `null` and the owner sees no gaps; the
 * unique key holds only over numbered rows, since nulls are distinct. Rows
 * outlive their files: retention deletes the R2 prefix and leaves the summary
 * readable.
 */
export const siteRevisions = pgTable(
  "site_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    /** One site per org today, seeded equal to `org_id`; baked into R2 keys. */
    siteId: uuid("site_id").notNull(),
    assignmentId: uuid("assignment_id").notNull(),
    version: integer("version"),
    summary: text("summary"),
    sourceKey: text("source_key").notNull(),
    artifactPrefix: text("artifact_prefix").notNull(),
    manifestKey: text("manifest_key").notNull(),
    status: siteRevisionStatus("status").notNull().default("building"),
    retireAfter: timestamp("retire_after", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [
    unique("site_revisions_id_org_key").on(t.id, t.orgId),
    unique("site_revisions_site_version_key").on(t.siteId, t.version),
    foreignKey({
      name: "site_revisions_assignment_fk",
      columns: [t.assignmentId, t.orgId],
      foreignColumns: [assignments.id, assignments.orgId],
    }),
    check("site_revisions_version_positive", sql`version > 0`),
    orgIsolation("site_revisions"),
  ]
)

export const approvalDecision = pgEnum("approval_decision", [
  "approved",
  "rejected",
])

/**
 * An `ApprovalRequest` and, once, its `ApprovalDecision` (§7.3, §19, ADR-032).
 * `target` is the contract's union as jsonb; a revision target also fills
 * `revision_id`, which a check keeps equal to the target, so the foreign key
 * and the one-open-request index can reach it. The decision columns are all
 * null or all set, and a trigger (migration 0008) refuses to change a decided
 * row or a request's target. `decided_by` is the contract's union: an owner
 * session, or the staff console.
 */
export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    assignmentId: uuid("assignment_id"),
    requestedByStaffId: uuid("requested_by_staff_id").notNull(),
    approverStaffId: uuid("approver_staff_id").notNull(),
    actionKind: text("action_kind").notNull(),
    target: jsonb("target").notNull(),
    revisionId: uuid("revision_id"),
    rationale: text("rationale").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decision: approvalDecision("decision"),
    decidedBy: jsonb("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [
    unique("approvals_id_org_key").on(t.id, t.orgId),
    foreignKey({
      name: "approvals_assignment_fk",
      columns: [t.assignmentId, t.orgId],
      foreignColumns: [assignments.id, assignments.orgId],
    }),
    foreignKey({
      name: "approvals_revision_fk",
      columns: [t.revisionId, t.orgId],
      foreignColumns: [siteRevisions.id, siteRevisions.orgId],
    }),
    check(
      "approvals_revision_matches_target",
      sql`coalesce(target->>'kind' = 'revision', false) = (revision_id is not null) and (revision_id is null or revision_id::text = target->>'revision_id')`
    ),
    check(
      "approvals_decision_complete",
      sql`(decision is null) = (decided_by is null) and (decision is null) = (decided_at is null)`
    ),
    check("approvals_expires_after_request", sql`expires_at > requested_at`),
    uniqueIndex("approvals_one_open_per_revision")
      .on(t.revisionId)
      .where(sql`decision is null and revision_id is not null`),
    orgIsolation("approvals"),
  ]
)

export const deploymentKind = pgEnum("deployment_kind", ["publish", "rollback"])

/**
 * Which revision a site serves (§11.1.3, ADR-032). Append-only: the active
 * revision is the row with the highest `config_version` for the site, and the
 * previous one is that row's `previous_revision_id`. There is no mutable
 * pointer column, so activation is one insert under a unique constraint, the
 * idempotent step §13 asks for. A publish carries the approval it acted on and
 * a rollback carries none. `reme_app` holds SELECT and INSERT only (migration
 * 0008).
 */
export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    siteId: uuid("site_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    previousRevisionId: uuid("previous_revision_id"),
    configVersion: integer("config_version").notNull(),
    kind: deploymentKind("kind").notNull(),
    approvalId: uuid("approval_id"),
    reason: text("reason"),
    createdAt,
  },
  (t) => [
    unique("deployments_site_config_version_key").on(t.siteId, t.configVersion),
    foreignKey({
      name: "deployments_revision_fk",
      columns: [t.revisionId, t.orgId],
      foreignColumns: [siteRevisions.id, siteRevisions.orgId],
    }),
    foreignKey({
      name: "deployments_previous_revision_fk",
      columns: [t.previousRevisionId, t.orgId],
      foreignColumns: [siteRevisions.id, siteRevisions.orgId],
    }),
    foreignKey({
      name: "deployments_approval_fk",
      columns: [t.approvalId, t.orgId],
      foreignColumns: [approvals.id, approvals.orgId],
    }),
    check(
      "deployments_publish_has_approval",
      sql`(kind = 'publish') = (approval_id is not null)`
    ),
    check("deployments_config_version_positive", sql`config_version > 0`),
    orgIsolation("deployments"),
  ]
)

/** `Conversation.kind`. The onboarding row is the server's; owners make `assistant` ones. */
export const conversationKind = pgEnum("conversation_kind", [
  "onboarding",
  "assistant",
])

/**
 * An owner's conversation with the assistant. A create from the owner app
 * carries the client's thread id as `idempotency_key`, so a retried create
 * returns the same row; the server-made onboarding row carries none, and an org
 * has at most one of those.
 */
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    kind: conversationKind("kind").notNull(),
    /** Owner text, 1 to 120 characters with something in them, or none yet. */
    title: text("title"),
    createdByStaffId: uuid("created_by_staff_id").notNull(),
    idempotencyKey: text("idempotency_key"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [
    unique("conversations_id_org_key").on(t.id, t.orgId),
    unique("conversations_org_idempotency_key").on(t.orgId, t.idempotencyKey),
    foreignKey({
      name: "conversations_created_by_fk",
      columns: [t.createdByStaffId, t.orgId],
      foreignColumns: [staff.id, staff.orgId],
    }),
    uniqueIndex("conversations_one_onboarding_per_org")
      .on(t.orgId)
      .where(sql`kind = 'onboarding'`),
    // The list, `order by updated_at desc, id desc`, read by a backward scan.
    index("conversations_org_updated_idx").on(t.orgId, t.updatedAt, t.id),
    // A header past the btree's row limit would fail the index as a 500.
    check(
      "conversations_idempotency_key_length",
      sql`char_length(idempotency_key) between 1 and 255`
    ),
    check(
      "conversations_title_text",
      // ASCII whitespace only, spelled out: `[:space:]` follows the database
      // locale, and this check must never refuse a title the contract takes.
      sql`char_length(title) between 1 and 120 and title ~ '[^ \\t\\n\\v\\f\\r]'`
    ),
    orgIsolation("conversations"),
  ]
)

/**
 * One message per row, in assistant-ui's `{id, parent_id, format, content}`
 * storage shape. Ids are the AI SDK's text ids, unique within a conversation,
 * so a retried write of the same message inserts nothing. `content` holds no
 * metadata: the api adds the date from `created_at` when it reads. `seq` is
 * the read order: `created_at` is the transaction's start, so a message and
 * its reply written together share one.
 */
export const conversationMessages = pgTable(
  "conversation_messages",
  {
    conversationId: uuid("conversation_id").notNull(),
    id: text("id").notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    parentId: text("parent_id"),
    format: text("format").notNull(),
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    createdAt,
  },
  (t) => [
    primaryKey({
      name: "conversation_messages_pkey",
      columns: [t.conversationId, t.id],
    }),
    foreignKey({
      name: "conversation_messages_conversation_fk",
      columns: [t.conversationId, t.orgId],
      foreignColumns: [conversations.id, conversations.orgId],
    }),
    // A parent is a message already in the same conversation.
    foreignKey({
      name: "conversation_messages_parent_fk",
      columns: [t.conversationId, t.parentId],
      foreignColumns: [t.conversationId, t.id],
    }),
    index("conversation_messages_conversation_seq_idx").on(
      t.conversationId,
      t.seq
    ),
    check(
      "conversation_messages_ids_are_text_ids",
      sql`id ~ '^[A-Za-z0-9_-]{1,64}$' and parent_id ~ '^[A-Za-z0-9_-]{1,64}$'`
    ),
    // The self-reference would otherwise be satisfied by the row itself.
    check("conversation_messages_not_own_parent", sql`parent_id <> id`),
    orgIsolation("conversation_messages"),
  ]
)

/** `Reminder.source`: the owner wrote it, or the assistant made it with the owner's yes. */
export const reminderSource = pgEnum("reminder_source", ["owner", "assistant"])

/**
 * A reminder the owner set, or one the assistant made in a conversation.
 * Reminders derived from open items are computed, never stored here. A create
 * carries its request's key as `idempotency_key`, so a retried create returns
 * the same row. A conversation is never deleted, only archived, so the
 * conversation key has no `on delete set null`: that would null `org_id` too,
 * which the key shares.
 */
export const reminders = pgTable(
  "reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    /** Owner text, 1 to 200 characters with something in them. */
    title: text("title").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    doneAt: timestamp("done_at", { withTimezone: true }),
    source: reminderSource("source").notNull(),
    conversationId: uuid("conversation_id"),
    createdByStaffId: uuid("created_by_staff_id").notNull(),
    idempotencyKey: text("idempotency_key"),
    createdAt,
    updatedAt,
  },
  (t) => [
    unique("reminders_org_idempotency_key").on(t.orgId, t.idempotencyKey),
    foreignKey({
      name: "reminders_conversation_fk",
      columns: [t.conversationId, t.orgId],
      foreignColumns: [conversations.id, conversations.orgId],
    }),
    foreignKey({
      name: "reminders_created_by_fk",
      columns: [t.createdByStaffId, t.orgId],
      foreignColumns: [staff.id, staff.orgId],
    }),
    // The list: open ones first, soonest due first.
    index("reminders_org_done_due_idx").on(t.orgId, t.doneAt, t.dueAt),
    // A header past the btree's row limit would fail the index as a 500.
    check(
      "reminders_idempotency_key_length",
      sql`char_length(idempotency_key) between 1 and 255`
    ),
    check(
      "reminders_title_text",
      // The same ASCII whitespace as `conversations_title_text`, for the same reason.
      sql`char_length(title) between 1 and 200 and title ~ '[^ \\t\\n\\v\\f\\r]'`
    ),
    orgIsolation("reminders"),
  ]
)

/** `DomainOrigin`: connected by the owner, or bought through Reme. */
export const domainOrigin = pgEnum("domain_origin", ["connected", "purchased"])

/** `ConnectMethod`: how the domain points at Reme. */
export const connectMethod = pgEnum("connect_method", [
  "records",
  "domain_connect",
  "purchased",
])

/**
 * `DomainState`. `removed` rows stay, so a later claim on the name can ask
 * for a TXT. Order matters: a claim is live while its state sorts before
 * `failed` (`domains_live_name`), so a new live state goes before it.
 */
export const domainState = pgEnum("domain_state", [
  "awaiting_payment",
  "awaiting_dns",
  "verifying",
  "active",
  "failed",
  "abandoned",
  "removed",
])

/**
 * A custom domain an owner connected to their site, or bought through Reme
 * (`origin = 'purchased'`, priced, waiting on Checkout until paid). `name` is the zone apex,
 * lowercase and punycode; `primary_host` is the apex or its `www.`. Postgres is
 * the truth and the router's `host:` pointers in KV are a cache of the active
 * rows. A name has one live row across all orgs, so that index is a plain
 * unique index: a second claim fails on the unique violation and never reads
 * the other org's row. The router's fallback finds an active row from the
 * request host through `resolve_domain_host` (migration 0015).
 */
export const domains = pgTable(
  "domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    /** The site the domain serves. Not a foreign key, like `deployments.site_id`. */
    siteId: uuid("site_id").notNull(),
    name: text("name").notNull(),
    primaryHost: text("primary_host").notNull(),
    origin: domainOrigin("origin").notNull(),
    method: connectMethod("method").notNull(),
    state: domainState("state").notNull(),
    onCloudflare: boolean("on_cloudflare").notNull().default(false),
    /** Cloudflare ids: the custom hostnames and the like. */
    cfIds: jsonb("cf_ids").notNull().default(sql`'{}'::jsonb`),
    /** `DomainProvider`, `{name, settings_url}`, from detection. */
    provider: jsonb("provider"),
    /** Another org held this name before, so ownership needs a TXT record. */
    needsTxt: boolean("needs_txt").notNull().default(false),
    /**
     * Cloudflare's ownership TXT per host, `{[host]: {name, value}}`, kept
     * from when the hostname was claimed so a `needs_txt` claim can be checked
     * against it after Cloudflare stops showing it.
     */
    ownership: jsonb("ownership").notNull().default(sql`'{}'::jsonb`),
    /** The approval that let the connect through; one domain per approval. */
    approvalId: uuid("approval_id").unique(),
    /** The last `DomainCheck`. */
    lastCheck: jsonb("last_check"),
    /** A purchase's `DomainStripe`: Stripe ids only, never a secret or card data. */
    stripe: jsonb("stripe"),
    /** A purchase's `DomainPrice`, from the price table and the live check. */
    price: jsonb("price"),
    /** A bought domain's `DomainRegistration`. The registrant itself is never stored. */
    registration: jsonb("registration"),
    createdAt,
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: "domains_approval_fk",
      columns: [t.approvalId, t.orgId],
      foreignColumns: [approvals.id, approvals.orgId],
    }),
    // No `www.` prefix: `resolve_domain_host` strips one, so a live `www.x`
    // beside a live `x` would put two orgs behind one host.
    check(
      "domains_name_lowercase_apex",
      sql`name ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' and char_length(name) <= 253 and name not like 'www.%'`
    ),
    check(
      "domains_primary_host_of_name",
      sql`primary_host in (name, 'www.' || name)`
    ),
    // A purchase is bought and priced, and only a purchase waits on payment.
    // `::text` because 0017 adds these enum values, and Postgres refuses a
    // new value as a literal in the transaction that added it.
    check(
      "domains_purchase_shape",
      sql`(origin::text = 'purchased') = (method::text = 'purchased') and (origin::text <> 'purchased' or price is not null) and (origin::text = 'purchased' or state::text not in ('awaiting_payment', 'abandoned'))`
    ),
    // One live claim on a name, across orgs; an expired Checkout frees it.
    // The live states are the ones sorting before `failed` (see
    // `domainState`): an index predicate takes no `::text`, which is stable.
    uniqueIndex("domains_live_name").on(t.name).where(sql`state < 'failed'`),
    index("domains_org_state_idx").on(t.orgId, t.state),
    orgIsolation("domains"),
  ]
)
