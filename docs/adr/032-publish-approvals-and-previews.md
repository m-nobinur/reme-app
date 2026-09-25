# ADR-032: Publishing is its own Workflow, approvals arrive at rest, previews trust the claim

Status: accepted, 2026-09-15. Applies to `apps/orchestrator`, `packages/gates`, `packages/contracts`,
`packages/db`, the router of the plan's P2 and the publisher of P3. Amends ADR-031 on when the
sandbox is destroyed and ADR-030 on staging hostnames (see its amendment of the same date).
Changes no DR.

## Context

The assignment Workflow ends at `preview_ready`. §8.4 says approval waits are `step.waitForEvent`
inside that instance, and that owner approval moves `awaiting_review` to `release_candidate` and
then to `published`. Four facts make a waiting instance the wrong shape. Rollback has no
assignment, so it needs an entry point that is not an assignment instance. §13 parks an unanswered
review after 72 hours, and a late approval must still publish, so it cannot depend on an instance
still listening. The console preview (#70) supersedes a `preview_ready` assignment, and a waiting
instance would have to be found and terminated every time. And a wait measured in days inside an
instance means every deploy lands mid-wait, the case open item 46 names and never solved.

Postgres already holds assignment state and the Workflow only executes it, so a row at rest in
`awaiting_review` with no live instance is consistent with how the track already works.

Three other questions arrived with the same stories. The staff console approves with a bearer, and
§14 wants an approval to be an owner-signed record. A preview router needs a way to know which
revision a host shows. And the publisher needs a home.

## Decision

**Publishing is a `PublishWorkflow` in `apps/orchestrator`, created by approval, never an event to
a waiting build.** `POST /:id/review` moves `preview_ready` to `awaiting_review` and records an
approval request for the latest `preview` revision, expiring 72 hours later, in one transaction.
`POST /:id/approve` takes the revision the reviewer saw, refuses unless it equals the open
request's target, writes the decision, and creates a `PublishWorkflow` whose instance id is the
approval id, so a second create is refused. Publishing re-reads the decision, verifies every
manifest hash, activates in one transaction (a `deployments` row, the revision `published`, the
assignment `published`), writes the routing pointer, and probes at 0, 2, 5 and 10 minutes with
the gates' own functions, rolling back on failure. Rollback is the same Workflow without the
approval step, and never moves an assignment. The hourly sweep parks expired reviews in
`blocked_on_approval`; nothing auto-publishes, and a late approval is still a human act.

**`deployments` is append-only.** The active revision is the row with the highest
`config_version` for the site, and the previous revision is that row's `previous_revision_id`.
There is no mutable `active_revision` column: an insert under a unique constraint is the
idempotent step §13 asks for.

**A console approval is recorded as a console approval.** `ApprovalDecision.decided_by` is either
an owner session or `console`. The publisher accepts `console` only where the Worker variable
`CONSOLE_APPROVALS` is `allow`, which staging sets and production does not. The orchestrator does
not sign the record with a key it also holds, because that proves nothing to itself. The owner
path arrives when `apps/api`, which holds the sealed session, writes decisions over a service
binding.

**Previews trust the signed claim.** A preview host shows a revision that never changes, so the
router needs no pointer for it. `PreviewClaim` carries the org, the revision, the host and the
expiry, is minted by the orchestrator after it resolves the org, and is verified by the router,
which requires the claim's host to equal the request's and serves only files the revision's
manifest lists. The router and the orchestrator share `PREVIEW_KEY`. The routing pointer
`SitePointer` exists for published hosts only, written by the publisher.

**The gates run outside the sandbox, in a Worker step against the artifact.** Build integrity,
links, structured data and the content gate are computed from what will be served; the type check
is taken from the sandbox's reported `astro check`, because a Worker cannot run `astro`. A failed
gate goes back to the same Developer conversation as a signal; a fourth failure ends in `failed`.

**The sandbox is destroyed when the build instance ends**, at `preview_ready`, `failed` or
`cancelled`, rather than at publish as ADR-031 said. The source snapshot is already in R2 by then,
and a review lasting days should not hold a container from a pool of five.

**Deploys and waiting instances (open item 46).** Step bodies carry ids only, as they already do.
A test drives each Workflow path with a recording fake step and commits the ordered step names to
`apps/orchestrator/test/workflow-steps.json`. When that file differs from the deployed commit, the
staging deploy lists running, queued and paused instances and refuses while any exist; an
unchanged file deploys freely.

**No purge token.** Worker responses are not cached unless the Worker uses the Cache API, which is
per data center, so there is nothing global to purge. HTML is served `no-cache` and hashed assets
`immutable`.

## What was rejected

- **The build instance continuing into `awaiting_review` with a 72 hour wait.** It would hold every
  deploy hostage to open reviews and give rollback no entry point.
- **An `apps/publisher` Worker.** The publisher needs Hyperdrive, R2 and one KV binding and no
  credential, so a second deployable buys nothing. Only `publish.ts` may reference the routing KV
  binding, enforced by a test.
- **An orchestrator-signed approval record.** A signature by a key the same Worker holds is not an
  owner's.
- **Resolving previews through `orgs.slug` and `site_revisions` on every request.** A Postgres read
  in a Worker not placed near the database, to prove what the claim already proves.
- **A code version in Workflow params that parks mismatched instances.** The Workflow is a linear
  script, so a parked instance has nothing to resume it.
- **Refusing every deploy while anything waits.** An information wait lasts up to seven days.

## Consequences

- §8.4's approval wait sentence is replaced by a pointer here. `revising` is not built by the
  builder track; a revise of a published site is a new `site.revise` assignment restored from the
  active deployment's revision, recorded as open item 49.
- Contracts land before their stories: `PreviewClaim` before the router, `SitePointer` and
  `ApprovalDecision` before the publisher. The `deployments` and `approvals` tables land in their
  own migration with row level security before the publisher.
- `packages/gates` is a new package, pure over contract types, and never imports `@workspace/db`.
- The console's `staging-preview.remeai.co.uk` stand-in keeps working until the router replaces it
  (issue #71), and `PREVIEW_KEY` survives that deletion.
- `CONSOLE_APPROVALS` must be gone before the first production publish, or when `apps/api` gains the
  owner approval route, whichever comes first.

## Change if

An approval needs to change a build in flight rather than a revision at rest; the publisher needs a
credential rather than a binding (a Cloudflare for SaaS token, a purge token), at which point it
moves to its own Worker behind a service binding; or Cloudflare documents that a resumed instance
runs its original code, which would retire the step-name check.

## Amendment, 2026-09-16: the sweep enumerates orgs through a platform read

The hourly sweep runs across tenants, and the tenancy kit had no read that does. Migration 0009
adds `public.list_org_ids()`, a SECURITY DEFINER function on the shape of `resolve_org_by_slug`,
returning every org id and nothing else; `listOrgIds(kit)` calls it as `reme_app` with no org
context and hands out no handle, and every read that follows opens that org's own `withOrg`. This
is a platform read under §9.2 in the same class as `resolve_org`, and narrower: it takes no
argument an attacker could enumerate against. The tenancy suite declares it with a probe and
drives the refusal that matters, that an id from the list reads nothing without a context.

Rejected: a Workflow per org created at publish time, which never sweeps an org that stops
publishing, and a work-filtered definer function, which couples a security boundary to three
tenant tables and needs a migration whenever the sweep's definition of work changes.

The sweep is one instance per hour, `sweep-YYYYMMDDHH`, over every org in chunks of 50, created
by the orchestrator's `scheduled` handler from a cron; each org parks its expired reviews, re-drives
what queued behind a site lock, and deletes the files of revisions past their window through the
one guarded delete. A parked review stays approvable, and an approval from the park accepts the
expired request, so a late approval still publishes as this ADR says. Reversal trigger, for both
the plain id list and the per-org fan-out: orgs past roughly 500, or a run's wall clock past an
hour, at which point the selection moves to orgs with work due or to one instance per chunk.
ADR-031 wrote "a daily sweep"; this ADR's hourly sweep is the one built, and ADR-031 reads as
amended by it.

## Amendment, 2026-09-26: the owner reaches the orchestrator over a binding

`apps/api` reaches the orchestrator through a named `OwnerApi` WorkerEntrypoint over a service
binding. It shares the console's route tree, takes the org, WorkOS user and session ids from
headers that only a binding can deliver, and records decisions as `owner_session`. A preview's
three screenshots also answer to a `?t=` claim whose `scope` is `screenshots`, which never opens
a page. Staging keeps `CONSOLE_APPROVALS` for the eval harness by the owner's decision of
2026-09-25, so the trigger "when `apps/api` gains the owner approval route" is withdrawn;
production still never sets it.

The owner's tree holds seven routes: create, answer, cancel, steer, preview, approve and reject.
Every other console route answers 404 there. An owner's build asks for its own review when it
reaches `preview_ready`, so the 72 hour clock starts when the preview exists; the console still
asks with `POST /:id/review`.

A staging spike on 2026-09-26 is the evidence that no public path reaches the entrypoint. A
Worker bound to `reme-orchestrator#OwnerApi` got the entrypoint's answer. Forged `x-reme-*`
headers on the custom domain, with and without a version override, got the console's 401, and
the orchestrator serves no version URLs (`workers_dev: false`).
