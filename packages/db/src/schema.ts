import { sql } from "drizzle-orm"
import {
  char,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

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
    createdAt,
    updatedAt,
  },
  (t) => [
    unique("orgs_workos_organization_key").on(t.workosOrganizationId),
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
     * replays a session. It is allocated by the single writer of that stream
     * rather than by the database, so there is no counter row to serialise on;
     * the unique index below refuses a duplicate, and refusing the out-of-order
     * append §13 asks for is one probe on that same index.
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
    // The aggregate replay reads: one seq per session, no gaps to argue about.
    // No WHERE any more, because a row with no session now has no seq either
    // and two of those do not collide: NULLs are distinct in a unique index.
    uniqueIndex("events_session_seq_key").on(t.sessionId, t.seq),
    index("events_org_occurred_idx").on(t.orgId, t.occurredAt),
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
