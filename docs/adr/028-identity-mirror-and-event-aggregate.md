# ADR-028: The identity mirror, the event aggregate and the staff lifecycle log

Status: accepted, 2026-08-28. Applies to `packages/db`, `packages/contracts`, the tenancy suite, and
every endpoint that reads a person, a session event or a staff lifecycle event.

Changes no DR. DR-4 is the reason the first ruling goes the way it does and is unchanged. §5.2 left
three shapes undefined, the migration that created the tables chose them, and this ADR defines them.
§5.2 and §19 are corrected to match.

## Context

Three shapes reached `packages/db/src/schema.ts` without a decision behind them.

*`users`.* §5.2 defines neither `orgs` nor `users`, so `users` became a WorkOS mirror with `org_id`
and one row per (org, WorkOS user). The same person in two orgs is two rows, each with its own
`id`, `email` and `name`.

*`EventEnvelope.seq`.* The contract says "monotonic per aggregate" and never says what the aggregate
is. §13 repeats the phrase. It became the session: `seq` is `NOT NULL` on every row, and a partial
unique index constrains `(session_id, seq)` only where `session_id` is not null.

*`staff_events`.* §5.2 lists `actor, payload, ts`. The table shipped with `id` and `org_id` added,
because without `org_id` it cannot carry a policy and the tenancy gate fails it.

All three are cheap now and expensive once endpoints read them.

## What was checked

*The WorkOS model, from the installed SDK.* `@workos-inc/node` 10.11.0, at
`node_modules/.pnpm/@workos-inc+node@10.11.0/.../lib/factory-VM3aexOH.d.mts`. `User` (line 1452)
carries `id`, `email`, `emailVerified`, `name`, `firstName`, `lastName`, `profilePictureUrl`,
`lastSignInAt`, `locale`, `externalId`, `metadata` and timestamps, and holds no reference to an
organization. `OrganizationMembership` (line 2064) is the join: `id`, `organizationId`, `userId`,
`status`, `role`, `roles`, `directoryManaged`, `customAttributes`, timestamps.
`OrganizationMembershipStatus` is `'active' | 'inactive' | 'pending'`. `RoleResponse` is `{ slug }`.
`listOrganizationMemberships` accepts `{ userId }` with no `organizationId`, so "which orgs does
this person belong to" is a question WorkOS answers and our database does not have to.

*One user per email, checked against staging.* Creating a user, then creating a second with the
same address, is refused: `email_not_available`, `user_creation_error`, HTTP 400. WorkOS also
lowercases on store, so `Probe.Case@reme.invalid` comes back `probe.case@reme.invalid` and the
lowercase form is then refused as a duplicate too. Our mirror therefore only ever receives folded
addresses, and `users.email` carries a plain `UNIQUE` rather than a unique index on `lower(email)`.
Both probe users were deleted and staging is back to zero. This closes what an earlier draft of
this ADR left open, and the constraint is B5's to write.

*The tenancy suite's discovery rule*, `packages/db/tenancy/rls.test.ts`. It reads `pg_class` for
relkinds `r p v m f` in `public`. A stored table with no `org_id` column fails "has no table outside
the tenant boundary" unless it is named in `PLATFORM_TABLES`, which is empty and whose comment says
adding a name to it is a decision needing a reviewer. Every table with `org_id` must have RLS
enabled, at least one policy, a `USING` clause mentioning `app.org_id` on every policy, and a
`WITH CHECK` mentioning it on every policy that can write.

*What a new table is granted.* Migration `0001` grants `reme_app` SELECT, INSERT, UPDATE and DELETE
on all tables plus matching default privileges, so a table added tomorrow is readable by the app
role on creation and only a policy stops it.

*Where these tables exist.* Local dev, the CI service container, and throwaway Neon branches.
`.github/workflows/ci.yml` migrates a fresh container each run. No wrangler config in the repo
declares a Hyperdrive binding. There is no durable reader of any of these tables.

## Decision

### 1. `users` is global. `memberships` is the tenant table

The mirror takes the grain of the system it mirrors.

```sql
users (                                    -- platform table, no org_id
  id uuid PK default gen_random_uuid(),
  workos_user_id text NOT NULL UNIQUE,     -- their primary key, ours to join on
  email text NOT NULL UNIQUE,              -- WorkOS folds case and refuses duplicates
  name text,
  created_at, updated_at
)

memberships (                              -- tenant table, standard isolation
  id uuid PK default gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  user_id uuid NOT NULL REFERENCES users(id),
  workos_membership_id text NOT NULL UNIQUE,
  role text NOT NULL,                      -- RoleResponse.slug
  status text NOT NULL,                    -- active | inactive | pending
  created_at, updated_at,
  UNIQUE (org_id, user_id),
  UNIQUE (org_id, id)
)
```

`staff.user_id` keeps its column and retargets its foreign key: `(org_id, user_id)` references
`memberships(org_id, user_id)`. The column order matches the unique constraint, so nothing here
rests on Postgres matching a foreign key by column set. The property §5.2 is built on survives
intact: a `kind = 'human'` staff row in one org can only point at a person who holds a membership in
that same org, and Postgres refuses the alternative. `MATCH SIMPLE` means a null `user_id` skips the
check, which is what an agent staff row wants. Membership rows are never hard-deleted; leaving an
org sets `status = 'inactive'`, because §5.4 keeps the staff row forever and the foreign key is
`no action`.

Row-level security:

- `memberships_org_isolation`, the standard `org_id = current_org()` policy for all commands.
- `users_member_read`, `FOR SELECT`, `USING (exists (select 1 from memberships m where
  m.user_id = users.id and m.org_id = nullif(current_setting('app.org_id', true), '')::uuid))`.
  The org test is written out rather than left to compose through the memberships policy, so the
  `USING` text names `app.org_id` and the guarantee does not depend on a second table's policy
  staying as it is. An org sees exactly the people it has memberships for.
- `users_self_insert` (`FOR INSERT`) and `users_self_update` (`FOR UPDATE`), both keyed on
  `workos_user_id = nullif(current_setting('app.workos_user_id', true), '')`. Sign-in mirrors the
  person who is signing in and nobody else. A membership-derived write policy cannot work here:
  the membership references the user, so at sign-up the user row has to exist first and no
  membership can vouch for it yet.
- No delete policy. Removing a person is the deletion workflow in §10.5 and runs as the migrator.

`withOrg` gains a second transaction-local setting, `app.workos_user_id`, set with
`set_config(..., true)` exactly as `app.org_id` is, from the sealed session and never from client
input. Unset it reads as NULL and matches nothing, so fail-closed stays the resting state. It opens,
holds and closes nothing, so it does not touch the connection-lifetime problem already open against
`withOrg`.

`users` becomes the first entry in `PLATFORM_TABLES`. That entry is not an exemption, and the suite
is extended so it cannot become one: a platform table still has to have RLS enabled, still has to
carry at least one policy whose `USING` names `app.org_id`, and still has to pass a cross-org denial
case driven through `withOrg`, where org A reads its own member and org B reads zero rows.

### 2. The aggregate is the session, and `seq` exists only where a session does

`seq` becomes nullable, paired to `session_id` by a check constraint, and the unique index loses its
`WHERE`:

```sql
seq integer NULL,
CONSTRAINT events_seq_pairs_with_session CHECK ((session_id IS NULL) = (seq IS NULL)),
CREATE UNIQUE INDEX events_session_seq_key ON events (session_id, seq);
```

This is what §10.6 already requires. Context derives from `deriveContext(sessionEvents,
contextPolicy)`, so the session is the stream anyone replays and the only stream whose position has
a meaning. Events with no session, which is every lifecycle transition, fact change and onboarding
step, get no `seq` rather than a required number nobody can interpret.

`seq` is allocated by the single writer of a session's stream, not by the database: no counter row,
no shared row to serialise on. The unique index refuses a duplicate. Refusing the out-of-order
append §13 asks for is the appender comparing against the session's last `seq`, one probe on that
same index. Ordering across sessions, where anything needs it, comes from `event_id`, which is a
ULID and sorts by append time, and from `recorded_at`.

This is contract-visible. `EventEnvelope.seq` becomes `z.int().nonnegative().nullable()` and the
object carries a `.check()` asserting `(session_id === null) === (seq === null)`, so the pairing is
one rule in one place rather than a database constraint the producers cannot see. `.check()` returns
`this` in Zod 4.4.3, verified in the installed types, so the object schema survives it.

### 3. `staff_events` keeps `id` and `org_id`, and stays a separate table

`id`, `org_id`, `staff_id`, `kind`, `actor_staff_id`, `payload` and `occurred_at`, as shipped.
Without `org_id` there is no policy and the gate fails the table. Without `id` there is no stable
row to point at, and §5.5 has evaluations citing `evidence_refs` into the log.

It stays separate from `events` because the two have different retention. §10.1 gives store 6 ninety
days hot and an archive after that; §5.4 keeps the staff record and its lifecycle for audit for the
life of the org. Folding one into the other archives the audit trail out from under the endpoints
that read it.

R7 is not weakened by having two logs. `staff_events` is a projection source, not model context.
Anything from it that reaches a model request is first written into `events`, which is what §10.6
already says about every injected snapshot.

## What changes, and in what order

The contract moves first, in its own PR, per R1.

1. `packages/contracts/src/event.ts`: `seq` becomes `.nullable()`, the envelope gains the
   `.check()` above, and the doc comment names the session as the aggregate. Regenerate, commit the
   generated output.
2. `packages/db/src/schema.ts`, one migration:
   - `users` loses `org_id`, `users_id_org_key`, `users_org_workos_user_key`, `users_org_email_key`,
     `users_workos_user_idx` and `users_org_isolation`. It gains `UNIQUE (workos_user_id)`,
     `UNIQUE (email)` and the three policies above.
   - `memberships` is new, with the columns, constraints and standard isolation policy above.
   - `staff_user_fk` retargets from `users(id, org_id)` to `memberships(org_id, user_id)`.
   - `events.seq` becomes nullable, gains `events_seq_pairs_with_session`, and
     `events_session_seq_key` drops its `WHERE session_id is not null`.
   - `staff_events` is unchanged.
3. `packages/db/src/map.ts` and `test/contract-alignment.test.ts` follow `seq` becoming nullable.
4. `packages/db/fixtures/golden.ts` and `tenancy/fixtures.ts` split their user rows into a user and
   a membership.
5. `packages/db/tenancy/rls.test.ts`: `users` is added to `PLATFORM_TABLES` and the platform-table
   cases described above are added in the same diff. The name and the proof land together.

This is a plain replacement migration, not expand/contract. R10 protects readers that are already
running, and there are none: every environment holding these tables is rebuilt from `0000` on each
run, and no wrangler config points a deployed worker at the database yet. It has to land before the
first Hyperdrive binding does. After that it is expand/contract and several times the work.

## What was rejected

*One row per (org, WorkOS user), the shape we have.* The failure it produces is identity fan-out. A
`user.updated` webhook carries one WorkOS user id and no organization. Under RLS the rows for that
person cannot be found in one transaction at all, so the handler either connects as a role that
bypasses RLS, which is the hole migration `0001` exists to close, or enumerates the person's orgs
from WorkOS and writes N transactions that can half-fail and leave two orgs disagreeing about one
person's email. The second tell is naming: the table is a membership table wearing a user's name,
and the first `role` column anyone adds to it makes `email` and `name` duplicated per org
permanently.

*Memberships only, with no global user row, reading identity from WorkOS when a screen needs it.*
Removes the drift and needs no platform table, and it is the smaller change. It also puts a vendor
round trip on every screen that shows a person, which is a cost DR-4 explicitly declines to pay for
tenant end-customers and should not pay for operators either.

*`seq` per org.* One counter per tenant serialises every append across every session and every staff
member, to order a stream nothing reads. §10.6 replays a session, not an org.

*`seq` per assignment.* An assignment spans sessions, retries and staff members, so its counter
needs coordination across sessions for an ordering the ULID already gives. Events with no
assignment would still carry a number that means nothing, which is the problem this ruling exists to
remove rather than move.

*Keeping `seq` `NOT NULL` with the partial index.* That is today's shape. Every non-session event
carries a required, unconstrained, meaningless integer. It is one field meaning two things depending
on the reader, which is the shape a contract is not allowed to have.

*Folding `staff_events` into `events`.* Two retention classes in one table, and the audit trail is
the one that loses.

## What this costs

The first name in `PLATFORM_TABLES`, and the suite work that keeps that name from being a way out of
the gate. One more GUC and one more field on the tenancy context. A join to put a person's email on
a screen inside an org.

## Change if

WorkOS ships a per-organization user population, at which point the per-org mirror becomes the
faithful one and this inverts.

Or a `users` read in a hot path fans out past a page of rows and measures badly, at which point
cache `email` and `name` on `memberships` and let `users` stay the write side. Not before a
measurement.

Or something in the product needs a total order across a whole org's event stream. That would be the
first real evidence for an aggregate wider than the session, and the question reopens with it.
