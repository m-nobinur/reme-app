# Production runbook

Written 2026-08-30 from the drill, not before it. Every number here was measured on
`reme-api-production`.

Production is `preview.remeai.co.uk` (`reme-web-production`) and
`api.remeai.co.uk` (`reme-api-production`), on the `reme-prod` Neon project
(`super-brook-02913792`). Staging is separate in every one of those: its own Workers, its own
Hyperdrive, its own Neon project. A merge to `main` cannot reach production.

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

## Checking production is actually healthy

`/health` is not a `select 1`. It asserts the four things `withOrg` promises on a live connection,
so it catches a credential pointed at a role holding BYPASSRLS and a migration that dropped a
policy, neither of which changes the status code of anything else.

```sh
curl -s https://api.remeai.co.uk/health
```

All four have to hold:

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

# 2. The api, then its health check before the web build spends two minutes.
pnpm --filter api exec wrangler deploy --env production
curl -s https://api.remeai.co.uk/health

# 3. The web app. CLOUDFLARE_ENV is read at BUILD time by the vite plugin, not at deploy time.
CLOUDFLARE_ENV=production pnpm --filter web build
pnpm --filter web exec wrangler deploy --config dist/server/wrangler.json

# 4. Rebuild for the default environment, or a later staging deploy uploads a production bundle.
pnpm --filter web build
```

Step 4 is not tidiness. `dist/server/wrangler.json` is the config a web deploy actually uploads,
and after a production build it names `reme-web-production` and carries the custom-domain route.

`pnpm db:migrate` refuses a `-pooler` host itself, because its advisory lock is session-scoped and
PgBouncer in transaction mode drops it silently. Neon's API hands out the pooled endpoint by
default, so ask for the direct one.

## Secrets

`infra/bootstrap.ts prod` pushes them from `.env.local`, and only onto a Worker that already
exists: a Worker that has never been deployed has nowhere to hold a secret, so the first run
reports `not deployed` and the run after the first deploy sets them.

`present` means the name exists on the Worker, not that its value matches `.env.local`. Wrangler
exposes no read for a secret value, so nothing can compare one. A rotated value reads `present` and
is not pushed; delete the secret to re-push it.

Production currently uses the **staging** WorkOS environment, by decision, because there are no
customers before launch and the production environment's API key cannot be minted from any surface.
Open item 13 lists what that defers.

## What is not drilled yet

The drill above rolled between two versions of identical code, so it measured the mechanism and the
clock honestly and did not measure a rollback out of a genuinely broken release. Do that on the
first release that has a real defect, and correct this file from it rather than from imagination.
