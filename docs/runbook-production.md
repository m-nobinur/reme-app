# Production runbook

Written 2026-08-30 from the drill, not before it. Every number here was measured on
`reme-api-production`.

Production is four Workers on the `reme-prod` Neon project (`weathered-rice-57505553`):

- `reme-web-production` on `preview.remeai.co.uk`
- `reme-api-production` on `api.remeai.co.uk`
- `reme-orchestrator-production` on `orchestrator.remeai.co.uk`
- `reme-router-production` on the zone route `*.remeai.co.uk/*`, which serves tenant sites and
  hands the service hostnames above back to their own Workers

Site artifacts live in the R2 bucket `reme-sites-production`, and the router reads its host
pointers from the KV namespace `reme-prod-routes`. Staging is separate in every one of those: its
own Workers, bucket, KV namespace, Hyperdrive and Neon project. A merge to `main` cannot reach
production.

## Rolling back

```sh
npx wrangler rollback <version-id> --cwd apps/api --env production --yes --message "why"
```

Measured on the api, twice: **the command returns in 7.8 s and `/health` is green again 8.4 s
after it was issued.** The criterion is five minutes, so the clock is not the risk.

Find the version to go back to with `npx wrangler versions list --cwd apps/api --env production`.
The web worker is the same command with `--cwd apps/web`, and it is slower to deploy because it
uploads 54 static assets, so budget more than the api's number for it.

Non-interactive callers need `--yes`. Without it wrangler asks twice, for a message and for
confirmation, and in CI it fills both from defaults but the prompt is still printed, which makes a
transcript hard to read.

## What a rollback does not do

**It moves code and not schema.** Wrangler says so and it is the thing to hold on to at 3am: a
rollback pairs the previous Worker with whatever migrations the failed release applied. Migrations
are expand/contract (R10), so the old code against the new schema is the pairing that is safe by
design; the reverse is not. If a release applied a migration and you roll the code back, you have
the supported combination. If you then want the schema back too, that is a new migration forward,
never a hand-edit.

It also does not roll back bound resources: KV, R2, Hyperdrive configs and secrets stay as they
are.

## Rolling a site back

A tenant site is a pointer, not a deploy: the router serves whichever revision the newest
`deployments` row for the site names, through a KV entry `host:{hostname}` (ADR-032). Rolling back
activates the previous revision through the same publisher Workflow that published it.

```sh
export ORCHESTRATOR_URL=https://orchestrator.remeai.co.uk
export ORCHESTRATOR_TOKEN=<the production orchestrator's token>
pnpm builder rollback <slug> "why"
pnpm builder site <slug>
```

The first prints the instance id and the revision being restored; the second shows what the host
serves and what the next rollback would restore. The instance appends a `deployments` row of kind
`rollback`, writes the pointer, and probes the host at 0, 2, 5 and 10 minutes. A second rollback
rolls forward again, because "previous" is whatever the newest row points at; the request is keyed
by its idempotency key so a retried command is one rollback. Staging runs the same commands against
`staging-orchestrator.remeai.co.uk` with the staging token.

## Cancelling a stuck assignment

Cancel is legal from every non-terminal state (§13 rule 3) and idempotent: the row moves first,
then the Workflow instance is terminated and the container destroyed, so a cancel on a build that
already settled changes nothing.

```sh
# With ORCHESTRATOR_URL and ORCHESTRATOR_TOKEN set as above.
pnpm builder cancel <slug> <assignment id>
```

A cancelled build's unpublished revisions enter the seven-day retention window in the same
transaction, which the `assignment.state_changed` event names as `retired_revisions`. A build
holding the site lock releases it on cancel, and the next hourly sweep re-drives whatever queued
behind it; `pnpm builder start <slug> <id>` does the same for one queued assignment at once.

## Forcing a retention sweep

The sweep runs on the hour from the orchestrator's cron and is idempotent, so running it again is
safe. It parks reviews unanswered for 72 hours, re-drives queued builds, and deletes the files of
revisions retired more than seven days ago through the one guarded delete, which refuses the
revision a site serves and the one a rollback would restore.

```sh
pnpm --filter orchestrator exec wrangler workflows trigger reme-sweep-production '{"hour":"manual-<why>"}' --env production
pnpm --filter orchestrator exec wrangler workflows instances list reme-sweep-production --env production
```

Staging's Workflow is `reme-sweep`, without `--env`.

The instance's output carries the counts (orgs, parked, redriven, deleted, failed) and each org
with work appends a `retention.swept` event; a `revision.files_deleted` event names every key
deleted. A sweep that deletes nothing for a week while retired revisions exist is the alert to
raise.

## Checking production is actually healthy

`/health` is not a `select 1`. It asserts the four things `withOrg` promises on a live connection,
so it catches a credential pointed at a role holding BYPASSRLS and a migration that dropped a
policy, neither of which changes the status code of anything else.

```sh
curl -s https://api.remeai.co.uk/health
curl -s https://orchestrator.remeai.co.uk/health
```

The orchestrator answers `{"status":"ok"}` and nothing more. For the api, all four have to hold:

```json
{"status":"ok","role":"reme_app","bypasses_rls":false,
 "org_context":"00000000-0000-4000-8000-0000000000ff","rows_for_absent_org":0}
```

The web worker needs its own check and cannot borrow the api's. A deployed `reme-web-production`
without its secrets answers **500 on every route, the public page included**, because the AuthKit
middleware validates config per request. Measured here on 2026-08-30: the first production deploy
answered 500 on `/` until `infra/bootstrap.ts prod` pushed the secrets, and 200 immediately after.
So `GET /` returning 200 is the whole config having survived a deploy.

## Deploying by hand

The workflow is the supported path. When it is unavailable:

```sh
# 1. Migrations first. Expand/contract means the new schema is safe under the old code.
DATABASE_URL=<direct, non-pooled, reme-prod> pnpm db:migrate

# 2. The orchestrator first: the api calls it. It builds with vite, so CLOUDFLARE_ENV is read at
#    build time here too. Then its health check and the sandbox probe, which calls
#    GET /sandbox/probe with the orchestrator's bearer.
CLOUDFLARE_ENV=production pnpm --filter orchestrator build
pnpm --filter orchestrator exec wrangler deploy --config dist/reme_orchestrator/wrangler.json
curl -s https://orchestrator.remeai.co.uk/health
ORCHESTRATOR_URL=https://orchestrator.remeai.co.uk ORCHESTRATOR_TOKEN=<token> \
  pnpm --filter orchestrator test:probe

# 3. The api, then its health check before the web build spends two minutes.
pnpm --filter api exec wrangler deploy --env production
curl -s https://api.remeai.co.uk/health

# 4. The web app. CLOUDFLARE_ENV is read at BUILD time by the vite plugin, not at deploy time.
CLOUDFLARE_ENV=production pnpm --filter web build
pnpm --filter web exec wrangler deploy --config dist/server/wrangler.json
curl -s -o /dev/null -w '%{http_code}\n' https://preview.remeai.co.uk/

# 5. The router last, as the workflow does, then the api and web checks again through it.
pnpm --filter router exec wrangler deploy --env production

# 6. Rebuild both vite apps for the default environment, or a later staging deploy uploads a
#    production bundle.
pnpm --filter orchestrator build
pnpm --filter web build
```

Step 6 is not tidiness. `dist/server/wrangler.json` and `dist/reme_orchestrator/wrangler.json` are
the configs a deploy actually uploads, and after a production build they name the production
Worker and carry its routes.

`pnpm db:migrate` refuses a `-pooler` host itself, because its advisory lock is session-scoped and
PgBouncer in transaction mode drops it silently. Neon's API hands out the pooled endpoint by
default, so ask for the direct one.

## Secrets

`infra/bootstrap.ts prod` pushes them from `.env.local`, the same file staging's run reads, so
today both environments hold the same values. Per Worker:

- `reme-web-production`: `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD`
- `reme-api-production`: the same three, and `OPENROUTER_API_KEY`
- `reme-orchestrator-production`: `ORCHESTRATOR_TOKEN`, `RUNTIME_SPEC_KEY`, `PREVIEW_KEY`,
  `OPENROUTER_API_KEY`, `REME_MODEL_PRIMARY`, `REME_MODEL_DEFAULT`, `REME_MODEL_FALLBACK`
- `reme-router-production`: `PREVIEW_KEY`, the same value as the orchestrator's

`ALERT_TO` on the orchestrator is the one production secret bootstrap does not push. It is the
owner's email address, so it goes onto the Worker by hand and stays out of `.env.local`; the
monitoring section has the command.

Bootstrap pushes only onto a Worker that already exists: a Worker that has never been deployed has
nowhere to hold a secret, so the first run reports `not deployed` and the run after the first
deploy sets them.

`present` means the name exists on the Worker, not that its value matches `.env.local`. Wrangler
exposes no read for a secret value, so nothing can compare one. A rotated value reads `present` and
is not pushed; delete the secret to re-push it.

Production currently uses the **staging** WorkOS environment, by decision, because there are no
customers before launch and the production environment's API key cannot be minted from any surface.
Open item 13 lists what that defers.

## Monitoring

The zone is on the Free plan, so Cloudflare Health Checks are not available, and Cloudflare
Notifications has no alert on a Worker's error rate. The production orchestrator runs its own
check instead: a cron every five minutes fetches each URL in its `HEALTH_URLS` var, which is
`api.remeai.co.uk/health` and `preview.remeai.co.uk/`. A URL
fails on anything but a 2xx, or on no answer within 10 s. Staging does not run the check.

Every run writes one line to Workers Logs for `reme-orchestrator-production`:

```json
{"type":"uptime.checked","ok":false,"checks":[{"url":"https://api.remeai.co.uk/health","ok":false,"ms":84,"status":503}]}
```

Query `type = uptime.checked` there for the history. A run with a failure also sends one email,
so an outage sends one every five minutes until it ends. A failed send logs
`uptime.alert_failed` with its code.

The check fetches the public hostnames, so it tests the same path a visitor takes. Measured on
the first production runs (2026-09-29): the api and the web app answer the orchestrator's fetch
with 200, while its fetch of its own hostname answers 522, so the orchestrator is not in the list.
The check running at all is its proof of life, which leaves one blind spot: an orchestrator that
is down entirely sends nothing, so silence in the `uptime.checked` history is itself the sign.

### The alert email

The check sends through the `send_email` binding `ALERTS` in the production block of
`apps/orchestrator/wrangler.jsonc`, from `alerts@remeai.co.uk` to the address in the `ALERT_TO`
secret, which keeps the address out of the repo. Email Routing is enabled on `remeai.co.uk`
(2026-09-29, `wrangler email routing enable`), and the binding can reach any verified destination
address on the account. To change the recipient, verify the new address under Email Routing, then:

```sh
pnpm --filter orchestrator exec wrangler secret put ALERT_TO --env production
```

Prove it once. Deploy with `https://api.remeai.co.uk/uptime-drill` added to `HEALTH_URLS`, which
the api answers 404, time the gap from the failing run's log line to the email, then deploy again
without it.

## What is not drilled yet

The drill above rolled between two versions of identical code, so it measured the mechanism and the
clock honestly and did not measure a rollback out of a genuinely broken release. Do that on the
first release that has a real defect, and correct this file from it rather than from imagination.

Restoring the production database has never been tried. Nobody has restored `reme-prod` to a
point in time, pointed a Hyperdrive config at the result, or measured how long either takes.
