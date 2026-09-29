# ADR-035: Deleting an owner's account frees the email and keeps the rows

Status: accepted, 2026-09-29. Applies to `apps/api`, `apps/web` and `packages/db`. Changes no DR.
Closes open item 79 and answers the reversal trigger in ADR-032's 2026-09-28 amendment for the
account half only; erasure stays with §10.5.

## Context

`users.email` is unique (`users_email_key`) and `users.workos_user_id` is unique. WorkOS gives a
person a new user id when they sign up again after their WorkOS user is deleted. Before this change
`createOrg` inserted the person with `on conflict do nothing`, found no row under the new id, and
threw a 500 after it had already created a WorkOS organization and membership. So an owner who
deleted their account and came back could never sign up again with the same address.

There was also no way to delete an account. `/app/account` was read-only, and only the staging
probe cleanup (`pnpm probe:clear`, ADR-032) removed anyone.

What the database lets `reme_app` do bounds the answer. `users` has no delete policy (ADR-028).
Memberships are never hard-deleted, because `staff_user_fk` points at them. `events`,
`staff_events` and `deployments` are append-only for `reme_app`, and approvals are write-once. A
real delete of an org's rows needs the migrator role, and ADR-032 rejected both an api route and a
SECURITY DEFINER function that would give the app that power.

## Decision

`DELETE /account` deletes the caller's own account. The org comes from the session, as on every
route. It needs an `Idempotency-Key` header and is refused for an impersonated session.

1. The caller must hold the org's `owner` membership (403 `account.not_owner`), and no other
   member may be active (409 `account.other_members`).
2. One `withOrg` transaction, using only the policies that already exist: the caller's `users.email`
   becomes `deleted+<users.id>@invalid` and `users.name` becomes null (`users_self_update`), the
   caller's membership becomes `inactive`, and one `account.deleted` event is appended with an
   empty payload.
3. Then WorkOS: the organization is deleted when WorkOS lists no other active member in it, and
   then the user. A 404 counts as done.

The database goes first so that a WorkOS failure can be retried. A second call finds the org
unresolvable, since `resolve_org` needs an active membership. It then finds the caller's own row
already carrying its tombstone and goes straight to the WorkOS half. After a full success a
second call also answers 204.

The tombstone is unique because it contains the row's own id. It cannot receive mail because
`.invalid` is reserved (RFC 2606). Its address frees the email for a new signup.

`createOrg` now writes the person before any WorkOS call, in a transaction of its own under the
fresh org id, the same context the org insert uses. If the email is held by another person's row,
signup answers 409 `account.email_taken` before a WorkOS organization exists. That happens only
when a WorkOS user was deleted some other way, for example from the dashboard.

`/app/account` gets a "Delete account" action behind a confirm step. It calls the route and then
signs out to the home page.

## What stays behind

The org's rows stay as an org nobody can resolve: `orgs`, `staff` (the owner's human row still
carries their display name), conversations, facts, events, builds and the tombstoned `users` row.
The published site stays live, because the router reads routing from Postgres and KV, and neither
checks membership. Erasing all of this, and revoking routing and hostnames first, is the deletion
workflow in §10.5. It needs its own ADR and runs as the migrator.

## Rejected

- Deleting the `users` row. It needs a delete policy on a platform table or the migrator role, and
  memberships and staff rows reference it.
- A SECURITY DEFINER lookup of `users` by email so `createOrg` could check before anything else.
  The person's own insert answers the same question with the policies that exist.
- Keeping the membership active until WorkOS succeeds. A person whose WorkOS user is gone and whose
  access token has expired cannot call again, which would strand an active membership with no
  identity behind it.

## Reversal trigger

The first org with more than one active member whose owner wants to leave, or the first erasure
request. The first needs ownership transfer; the second needs the §10.5 workflow.

## Amendment, 2026-09-29: deletion takes the site offline at once

The owner decided that deleting an account takes the website offline immediately. This replaces
"The published site stays live" above and the order in step 3 of the decision.

What makes an org closed is `orgOpen` in `packages/db`: no active membership held by a person whose
`users.email` is not a tombstone. `DELETE /account` now runs in this order:

1. The same refusals, then the caller's row becomes a tombstone. From this commit the org is closed,
   and the membership is still active, so the org still resolves for the owner.
2. The api calls the orchestrator's `POST /assignments/site/takedown` over the owner binding. It
   cancels every non-terminal assignment through the state machine, terminates each Workflow
   instance and ends each sandbox, then deletes the `host:<host>` routing key. It answers 204, and
   a repeat answers 204 again. The route is in the owner's tree only; the console's app answers 404.
   A takedown that does not answer 204 fails the route before anything reaches WorkOS.
3. The membership becomes inactive and `account.deleted` is appended, as before.
4. WorkOS, as before.

A retry after a failed takedown still resolves the org and takes the site down again. The takedown
runs after the org is closed so that nothing can write the key back: on a KV miss the router answers
410 "This site is no longer available." for a closed org and writes nothing to KV, on production as
on staging, where an unknown host would otherwise pass through. `writePointer` refuses a closed org
with `org.closed`, which ends a publish Workflow that was already running. A preview's signed claim
lasts a day, so the router also asks Postgres whether a preview's org is open and answers 410 when it
is not.

"At once" is bounded by caching. KV can go on returning a deleted key for up to a minute, and a data
centre that read the pointer from Postgres believes it for a minute (the router's `pointer` belief).
Each preview host's open or closed answer is believed for a minute the same way.

Erasing the org's rows stays the §10.5 job. So do the R2 artifacts, which are never mutated.
