# ADR-029: Resolving the tenant from the WorkOS organization

Status: accepted, 2026-08-28. Applies to `packages/db`, `apps/api`, `apps/web`, the tenancy suite,
and every endpoint that needs an `org_id` before it has one.

Changes no DR. It finishes what ADR-024 started: that ADR ruled Reme's `org_id` out of the session
cookie and said it is "resolved server-side per request from the authenticated user", and left the
resolution itself unspecified. This is that specification, plus the write path that gives it
something to resolve. §9.2 layer 1 is unchanged and this is how layer 1 is reached.

## Context

`apps/api` cannot resolve an `org_id` from a request, and the reason is structural rather than a
missing query.

`orgs` carries `id`, `slug`, `name` and timestamps. There is no WorkOS organization id anywhere in
the schema, so a sealed session holding `organizationId = "org_01J..."` has nothing to join to.
Nor is there a row to find: nothing in production code writes `orgs` at all. Every writer is a
fixture. `packages/db/fixtures/seed.ts`, `packages/db/tenancy/fixtures.ts` and one test are the
complete list, verified against `main` before this ADR was dispatched.

The root cause is a gap in delivered scope, not a design mistake. D2 is marked Done in
`.local/in-progress/phase-1-setup.md`, and one clause of it never shipped: "Signup creates the org
in our database transactionally with the WorkOS org." It could not ship in D2. `apps/api` did not
exist when D2 ran, and `apps/web` is lint-banned from `@workspace/db`, which was the condition
attached to building D2's pages in the web worker at all. So the story delivered eleven routes and
no org row, and the gap stayed invisible until B5 asked for the first identity-carrying read.

There is a second problem underneath the first, and it is the one that decides the shape. The
resolving read has to happen before any org context exists, which means it cannot go through
`withOrg`. Today that read would work anyway, because the API connects as `neondb_owner` and that
role holds `rolbypassrls`. That is not a property to build on. `packages/db/README.md` already
records the move to a login role without BYPASSRLS as an open gap, and the moment that lands, a
plain `select` on `orgs` outside a tenant transaction reads zero rows. A resolver that works only
while the connection is privileged is a resolver that breaks on the day the connection stops
being privileged, which is a day we are deliberately working towards.

## What was checked

Everything below was run against local Postgres 17 on 2026-08-28, inside a transaction that was
rolled back.

*The connecting role.* `select rolname, rolsuper, rolbypassrls from pg_roles where rolname =
current_user` returns `reme | t | t` locally and, per migration `0001`'s own comment,
`neondb_owner` with `rolbypassrls = true` on Neon, measured 2026-08-27 against project
`sparkling-wildflower-04343187`. A `SECURITY DEFINER` function created by the migrator is owned by
that role. It bypasses RLS by construction. Its body is the entire security boundary and there is
no second control behind it.

*That the bypass is real and not theoretical.* A table with RLS on and a policy keyed on
`app.org`, two rows, read two ways in one transaction as a `NOBYPASSRLS` role: the direct select
returned 0 rows, and a `SECURITY DEFINER` function over the same table returned 2.

*What a new function is granted.* `select proacl from pg_proc` for a freshly created function
returns NULL, which in Postgres means the default, and the default for a function is `EXECUTE` to
`PUBLIC`. The probe role called the definer function with no grant written anywhere. Migration
`0001`'s `ALTER DEFAULT PRIVILEGES ... ON TABLES` has nothing to do with this and does not need to:
functions arrive world-executable on their own. A `SECURITY DEFINER` function that nobody
remembered to revoke is callable by every role in the cluster.

*That `search_path` is visible from the catalog.* `proconfig` reads `{"search_path=\"\""}`. So a
function with a mutable `search_path` is discoverable, which is what lets the tenancy suite fail
one rather than trusting the author.

*`INSERT ... RETURNING` is checked by the SELECT policy.* This one changed the write path. With a
deny-all SELECT policy and a permissive INSERT policy, the plain insert succeeded and the same
insert with `RETURNING id` failed. The error is the generic `new row violates row-level security
policy for table "pu"`, with no hint that reading the row back is what was refused, so anyone
debugging it will look at the wrong policy first.

*The read shape the app gets.* `packages/contracts/src/org.ts` defines `Org` as `{ org_id, slug,
name, created_at }`, a strict object. The WorkOS organization id is not in it and is not going in
it: it is a join key, not something a screen shows.

*The whole thing, end to end, against the real schema.* The column, the constraint, the function,
the revoke and the grant were applied to a local database carrying migrations `0000` to `0004`, with
two probe orgs, two probe people and one `pending` membership, then rolled back. As `reme_app`,
with no org context set: A's user against A's organization returned A's uuid, A's user against B's
organization returned null, the `pending` membership returned null, an unmirrored organization
returned null, a null argument returned null, and a direct `select count(*) from orgs` in the same
transaction returned 0. That last pair is the argument for the function in one line. The read the
resolver needs is the read RLS is there to refuse.

## What changed since the ruling, and it simplifies things

When this was first ruled on, `apps/api` did not exist. It does now, merged as `9386480`, with a
Hyperdrive binding, a typed client and `/health`.

That retires D2's main objection to itself. D2 declined to create `apps/api` on the grounds that "a
second worker with one route the web worker immediately calls buys a service binding and a hop for
nothing before B5 needs a database." Correct at the time. B5 has now built that worker for its own
reasons, the database binding lives there, and `apps/web` still cannot import `@workspace/db`. So
signup in `apps/web` calling `apps/api` to write the org is the only shape left, and it is also the
shape §9.2 layer 1 wants: the one path to a handle stays in one worker.

The ruling itself does not change. The column, the resolver and the writer are what they were. What
changes is that the writer has an obvious home instead of an argument attached to it.

## Decision

### 1. `orgs` gains a nullable unique `workos_organization_id`

```sql
alter table orgs add column workos_organization_id text;
alter table orgs add constraint orgs_workos_organization_key unique (workos_organization_id);
```

In `packages/db/src/schema.ts`:

```ts
workosOrganizationId: text("workos_organization_id"),
// and, in the table's extras array:
unique("orgs_workos_organization_key").on(t.workosOrganizationId),
```

Nullable, because the golden fixture orgs have no WorkOS organization and must not acquire a
fabricated one. `brightclean`, `mopandbucket` and `emptyco` exist to be obviously fictional (R8),
and a `NOT NULL` here would force a made-up vendor id into every seed. Postgres treats nulls as
distinct in a unique constraint by default, so three fixture orgs with a null each coexist and the
constraint still refuses a second row claiming the same real organization.

Unique, because it is the join key a resolver reads and a duplicate makes tenant resolution
ambiguous, which is the worst possible failure in this position. It is also what makes the org
writer idempotent for free (R5): a retried signup hits the constraint instead of creating a second
tenant for one WorkOS organization.

No policy change. `orgs_org_isolation` still reads `id = current_org()` and the new column is
covered by it like any other column on the row. Not contract-visible either, so no contract PR
gates this half.

### 2. One `SECURITY DEFINER` resolver, taking both the user and the organization

```sql
create function public.resolve_org(
  p_workos_user_id text,
  p_workos_organization_id text
) returns uuid
language sql
stable
strict
security definer
set search_path = ''
as $$
  select o.id
  from public.orgs o
  join public.memberships m on m.org_id = o.id
  join public.users u on u.id = m.user_id
  where o.workos_organization_id = p_workos_organization_id
    and u.workos_user_id = p_workos_user_id
    and m.status = 'active'
$$;

revoke all on function public.resolve_org(text, text) from public;
grant execute on function public.resolve_org(text, text) to reme_app;
```

**What it takes.** Two vendor ids, both from the sealed session and never from a request body. The
user is `session.user.id`, the organization is the `organizationId` ADR-024 describes as decoded
from the access token. Our own `org_id` is not an input, which is the point: nothing a client sends
can name the tenant.

**Why both.** One argument is not enough in either direction. User alone cannot answer which org
when a person belongs to two, and picking one would make the answer depend on row order. Org alone
answers with no authorization at all, and would hand any caller any tenant. The pair is the
membership, and the membership is the authorization. This is also why the function returns the org
rather than a list: choosing among orgs is the `/choose-organisation` route D2 already built, and it
runs on WorkOS memberships before a session exists.

**What it returns.** The `orgs.id` uuid, or nothing. One column, because `withOrg` needs one value.

**What it must refuse,** and every one of these is a null result rather than an error, because a
caller distinguishing "no such membership" from "no such org" learns which organizations exist:

- a null argument, which `strict` refuses before the body runs;
- a user with no membership in that org;
- a membership whose `status` is not `active`, so `inactive` and `pending` do not resolve;
- an organization not mirrored in `orgs`, since the `where` cannot match a null column;
- our own `org_id`, which it has no parameter for.

**`search_path` is pinned to the empty string** and every relation in the body is schema-qualified.
This is the whole of the privilege escalation defence. A definer function that resolves `orgs`
through a mutable `search_path` runs whatever table the caller put in front of it, as the owner,
with BYPASSRLS. `set search_path = ''` and `public.orgs` together mean there is nothing to shadow.

**`EXECUTE` is revoked from `PUBLIC` and granted to `reme_app` alone**, because the default is
world-executable and the measurement above shows the default arriving silently.

**The call site enters the app role.** `packages/db` exports a `resolveOrg(kit, { workosUserId,
workosOrganizationId })` that opens a transaction, issues `set local role reme_app`, calls the
function, and returns the uuid or null. It does not set an org context and does not hand out a
handle. So `reme_app` remains the role everything runs as, and this is the one privilege it holds
that reads across orgs, in one function, with one caller.

**It is not a general escape hatch.** `resolve_org` is the only `SECURITY DEFINER` object we intend
to have. A second one is an ADR, not a migration.

### 3. The tenancy suite covers it, and it cannot hide

A function is invisible to the current gate. `rls.test.ts` discovers relations from `pg_class` for
relkinds `r p v m f`, so `pg_proc` is not read at all and a definer function added tomorrow passes
every case in the file by not being looked at.

The suite gains a `SECURITY_DEFINER_FUNCTIONS` map, shaped exactly like `PLATFORM_TABLES` and for
the same reason: naming the thing is the declaration, and the entry carries the probe that proves
it. Discovery adds `select p.proname, p.prosecdef, p.proconfig, p.proacl from pg_proc p join
pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`, and the cases are:

- every `prosecdef` function in `public` is named in the map, or the suite fails on it. This is the
  case that closes the hole, and it is the reason the map exists rather than a hardcoded list of
  assertions about `resolve_org`;
- `proconfig` contains a `search_path` setting, and it is `""`. A mutable one fails;
- `proacl` is not null and does not grant `EXECUTE` to `PUBLIC`. A null `proacl` is the default,
  and the default is the hole;
- a behavioural denial driven through the real call path, org A and org B both ways, the same shape
  the platform-table cases use: A's user with A's organization resolves to A, A's user with B's
  organization resolves to null, and an inactive membership resolves to null.

That last case is the one worth insisting on. Naming a table in `PLATFORM_TABLES` does not exempt
it, and this morning's proof of that is the model here: the entry still has to have RLS, still has
to have a policy naming `app.org_id`, and still has to produce a row for its own org and none for
the neighbour's. A `SECURITY DEFINER` function gets the same treatment. Declaring it is how you
take on the cases, not how you get out of them.

`tenancy/fixtures.ts` needs a WorkOS organization id and an active membership per probe org for
those cases to mean anything, in the same fictional style as the rest.

### 4. The org writer lands with it

The resolver is useless against an empty table, so the missing D2 clause ships in the same story.
`apps/web`'s signup calls `apps/api`, which after creating the WorkOS organization writes ours.

"Transactionally with the WorkOS org" cannot be literally true and should stop being written that
way. There is no transaction spanning a vendor API and Postgres. What is achievable, and what R5
asks for anyway, is that the WorkOS organization is created first and our write is idempotent
against it: `on conflict (workos_organization_id) do nothing`, so a retry after a crash between the
two finds the tenant already there and a signup replayed twice produces one org.

The write needs no new hole in RLS, which is worth spelling out because the obvious reading is that
it does. The API generates the org uuid itself, then runs all three inserts inside one
`withOrg({ orgId: newId, workosUserId })`:

- `orgs`, where `orgs_org_isolation`'s `WITH CHECK (id = current_org())` passes because the row's id
  is the context;
- `users`, where `users_self_insert` passes because the context names the person signing up;
- `memberships`, where the standard isolation policy passes on the same org id.

One trap, measured above and easy to hit. None of these inserts may use `RETURNING`. The SELECT
policy is applied to returned rows, `users_member_read` requires a membership that does not exist
yet at the moment the user row is written, and the failure arrives as a generic row-level security
error pointing at the wrong policy. Generate the uuids in the worker, insert without `RETURNING`,
and the ordering problem disappears with the read.

The request and response shapes cross the web-to-API boundary, so R1 applies and the contract lands
in its own PR first. This ADR does not design it.

## What changes, and in what order

1. Contract PR for the signup request and response, per R1.
2. One migration in `packages/db/drizzle`, on the direct endpoint. `scripts/migrate.ts` already
   refuses a host containing `-pooler`, and this migration creates a function, so running it
   through PgBouncer is exactly the case that guard exists for.
   - `orgs.workos_organization_id`, nullable, plus `orgs_workos_organization_key`.
   - `public.resolve_org`, with the revoke and the grant. Custom SQL, like `0001`: drizzle-kit does
     not model functions.
3. `packages/db/src/tenancy.ts` gains `resolveOrg`. Exported from `src/index.ts`, since `apps/api`
   is the caller.
4. `packages/db/tenancy/rls.test.ts` gains `SECURITY_DEFINER_FUNCTIONS`, the `pg_proc` discovery and
   the four cases. `tenancy/fixtures.ts` gains the organization ids and memberships they read.
5. `apps/api` gains the signup write and the session-to-`org_id` path that calls `resolveOrg`.
6. `apps/web`'s signup posts to it.

Expand only, so R10 is satisfied without a second release: a nullable column and a new function
take nothing away, and nothing reads either one until step 5.

## What was rejected

*A pre-tenant read of `orgs` and `memberships` with no definer function.* The straightforward
version, and it works today only because the API connects as a role holding BYPASSRLS. It fails
closed and silently the day we connect as the login role `packages/db/README.md` already commits
to, and it fails as "the user has no org" rather than as an error, which is a support ticket about
sign-in rather than a stack trace. Building on a privilege we are actively trying to give up is
building on sand.

*Deriving `org_id` from the WorkOS organization id with uuidv5.* Tempting, since it removes both the
column and the resolver. It makes our primary key a permanent pure function of a vendor identifier.
Every org row, every foreign key and every `org_id` in the event log then encodes a WorkOS id
forever, and DR-4's exit (WorkOS ships a consumer sub-population, or we leave) stops being a
migration and becomes a rewrite of the tenant boundary. It also has no answer for an org that has no
WorkOS organization, which is all three golden fixtures. Lock-in is a budget, and this spends it on
the one identifier that should be ours.

*A service binding from `apps/web` to a resolver in `apps/api`, with no schema change.* This does
not answer the question, it moves it. `apps/api` still has no way to turn a WorkOS organization into
an `org_id`, because the column it would read does not exist. The hop is real work for no answer.

*Resolving on the user alone and ignoring the organization.* One less argument, and it is wrong for
anyone in two orgs: the answer becomes whichever membership the planner returns first. Silent, and
it is a cross-tenant read.

*Resolving on the organization alone.* No authorization in it at all. Any caller holding an
organization id gets that tenant's `org_id`.

*Making the column `NOT NULL`.* Forces a fabricated WorkOS id into every fixture, which R8 forbids
and which would make the seeds lie about a real vendor's namespace.

*Putting `org_id` in the sealed session and skipping the resolver.* ADR-024 already refused this and
the reason still holds: a membership change would survive in the cookie until the next refresh.

## The delivery consequence, and it is a carry-over

B5's exit criterion "staff-directory read p95 under 150 ms on staging" cannot be met in this phase
at all.

Staging does not exist. It is E1, and E1 creates billable Cloudflare resources the owner has not
authorised. No amount of work inside B5 produces the number, so B5 carries the criterion to E1
rather than holding open, which is the shape C2 already used for its preview-deploy half.

What B5 measured instead is a floor, and it should be read as one: p50 8.0 ms, p95 10.8 ms on
`/health`, against a local Postgres with no Hyperdrive pool in front of it, as reported by the
engineer. I have not re-run it. It is a floor in the strict sense that the real number cannot be
better, and it is not a substitute for the criterion, because it measures neither the staff
directory nor Hyperdrive nor a network. E1 is where the real number arrives, on the staff directory,
through Hyperdrive, from staging.

## What this costs

One `SECURITY DEFINER` function, which is one deliberate hole in the tenancy model, offset by four
suite cases and a rule that a second one needs an ADR. One nullable column that is null for every
fixture org. One `EXECUTE` grant to `reme_app` that reads across orgs, in a body that returns one
uuid.

## Change if

WorkOS ships an organization id that is a uuid we would be willing to use as a primary key, at which
point the uuidv5 argument reopens on better terms. I do not expect it and would still want the
column.

Or the resolver shows up in a latency profile once staging exists. It is one indexed join per
request today. If it measures badly, the answer is caching the pair in the sealed session with a
short expiry, which reintroduces exactly the staleness ADR-024 refused, so it needs a measurement
first and its own ADR second.

Or `SECURITY DEFINER` stops being necessary, which happens if a resolving read can be made to work
under RLS without one. The shape that would do it is a policy on `orgs` and `memberships` keyed on
`app.workos_user_id` alone, the GUC ADR-028 already added. I looked at it and did not take it: it
widens two tenant tables' read policies permanently to save one function, and a policy that reads a
person rather than an org is the harder thing to reason about at 3am. If someone finds a version
that does not widen the policies, drop the function and take it.
