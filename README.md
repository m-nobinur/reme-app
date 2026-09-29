# Reme

An AI-native executive assistant, with a whole AI team behind it, for small service
businesses and the busy owners who run them.

You talk to one assistant, a Chief of Staff. It talks to everyone else. Behind it sits an
org of scoped AI staff it briefs and delegates to: staff that answer inquiries on every
channel, qualify and quote, chase follow-ups, book work, collect deposits through approved
workflows, run routine admin, and build and maintain the business's marketing website so
leads arrive in the first place. The owner gets one contact point and, from it, only the
decisions that need human authority — prepared, contextualised, one tap away.

The staff are real: rows with a lifecycle, a budget, permissions and an audit trail, not
chat personas. The org tree is the product's spine, and the UI reads it rather than
inventing it.

First vertical: residential and commercial cleaning.

## Vision

Small service businesses lose revenue because attention is scarce, not because leads are
bad. A human assistant fixes that, but is expensive, offline at night, and does not scale
with lead volume. Reme is the attention, coordination and action layer above CRM,
messaging, calendar and payments — each of those stays the system of record for its own
narrow domain.

Behaviour is the product, with an engineering budget behind it:

- **Knows the business.** Answers in its voice, with its real services, area and policies.
- **Eager, never noisy.** Notices stale leads, unchased quotes and schedule conflicts. If there is nothing meaningful to do, it does nothing.
- **Adaptive.** A correction becomes a declarative fact with provenance; the next conversation already reflects it. You tell it once.
- **Knows routine from consequential.** Money, availability exceptions and public commitments become a one-tap owner approval, never a vague alert.
- **Honest, and unbudgeable.** Discloses that it is the business's AI, admits uncertainty, and cannot be talked out of its instructions, prices or permissions by anything it reads.

## Getting started

Node 24 or newer (see `.nvmrc`) and pnpm.

```sh
git clone <repo> && cd reme
pnpm bootstrap    # git hooks, .env.local, dependencies
# put a DATABASE_URL in .env.local
pnpm preflight    # names what is still missing and the command that fixes it
pnpm dev          # or `pnpm dev:session` for a browser already signed in
```

It is `preflight` rather than `doctor` because pnpm has a built-in `doctor` command that
would shadow the script and report `All checks passed` without running any of ours.

`pnpm bootstrap` is safe to run again: every step is a no-op once it has been done. It is
also the only thing that sets `core.hooksPath`, so a clone that skips it runs no hooks at
all, meaning no commit-subject check and no secret scan.

Postgres is a Neon branch by default. Without one, set `NEON_OFFLINE=1` in `.env.local`
and take the offline `DATABASE_URL` from the comment in `.env.example`, then run
`pnpm bootstrap` again to start the pgvector container in `docker-compose.yml`.

`apps/api` reaches Postgres through a Hyperdrive binding rather than through
`DATABASE_URL`. Locally there is no Hyperdrive: `wrangler dev` connects to whatever
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` holds, and `pnpm dev` fills that
from the `DATABASE_URL` in `.env.local` so both reach the same database. Set the variable
yourself and it wins. That is also the answer when something else already owns port 5432:
publish the container somewhere else and move `DATABASE_URL` with it.

### A signed-in browser

```sh
pnpm dev:session            # a window on /app/approvals, signed in; close it to stop
pnpm dev:session --check    # headless: prove the page renders, then exit
pnpm dev:session --delete   # remove the owner, its org and the stored session
```

It signs in as your development owner, an account in the WorkOS staging environment named
from your git address: `owner+dev-<tag>@example.net`, where `<tag>` is the first 8 hex
characters of the SHA-256 of `git config user.email`, trimmed and lowercased. Its org is
"Dev Owner <tag> Cleaning (fictional)", with the starting team. Two developers never share
one. The first run creates both and every later run finds them, so there is only ever one
each. The command starts whichever of `web` and `api` is not answering on ports 3000 and
3001, refuses a port something else holds, and stops what it started.

The sign-in is real: a password that exists only for that run, then a session sealed with
this checkout's `WORKOS_COOKIE_PASSWORD`. The session is kept in `.dev-session.json`, which
is gitignored and readable only by you, and each run revokes the one before it.
`pnpm preflight` says whether it still works. The command refuses to run unless
`apps/web/.dev.vars` holds staging's client id and a key WorkOS confirms belongs to it.
`--delete` clears the local database's copy first and stops there if the database refuses,
so WorkOS is only touched once that has worked.

Secrets never enter a committed file. `.env.example` carries names and shapes,
`.env.local` carries values and is gitignored, and `packages/config` validates both so a
missing one fails at boot naming the variable.

## Staging

Every Cloudflare and Postgres resource staging needs is created by one script, from code.
Nothing is made in a dashboard.

```sh
node infra/bootstrap.ts staging
```

A second run changes nothing and exits 0. Each line says how it knows: `unchanged` on the
Hyperdrive config and the KV namespace is the account's own list answer, `unchanged` on the
database role is a `pg_roles` read, and `matches` compares the id the account holds against
the id committed in the Worker's `wrangler.jsonc`. `present` on a secret is weaker on
purpose and the script says so: wrangler exposes no read for a secret value, so it can only
tell that the name exists, not that the value still matches `.env.local`.

What it makes, and the names, which carry the project and the environment so no two
resources on the account can collide:

| Resource | Name | Bound as |
| --- | --- | --- |
| Hyperdrive config | `reme-staging-postgres` | `HYPERDRIVE` in `apps/api` and `apps/orchestrator` |
| KV namespace | `reme-staging-web-cache` | `CACHE` in `apps/web` |
| Postgres login | `reme_app` gains a password | the Hyperdrive origin credential |

Hyperdrive connects as `reme_app`, which has no `BYPASSRLS`, so the policies are evaluated
against the connecting role and the `SET LOCAL ROLE` inside `withOrg` is a second layer
rather than the only one. The password is generated at create time, handed to Hyperdrive and
not stored; if the Hyperdrive config is ever missing, the next run mints a new one. Query
caching is off, and that is a tenancy decision: Hyperdrive keys its cache on the query text
and its parameters, the org context is in neither, so two tenants would share a cache entry.

The script does not deploy, and a Worker that has never been deployed has nowhere to hold a
secret. `apps/api` also cannot deploy until the Hyperdrive id is committed. So a virgin
environment goes: run the script, commit the two ids it prints, deploy, run it again.

```sh
pnpm --filter api exec wrangler deploy
pnpm --filter web build
pnpm --filter web exec wrangler deploy --config dist/server/wrangler.json
```

Staging answers on <https://staging.remeai.co.uk>, <https://staging-api.remeai.co.uk> and
<https://staging-orchestrator.remeai.co.uk>, each a wrangler custom domain that the deploy
creates (ADR-030). The account's `*.workers.dev` subdomain is off for deployed Workers and
carries only pull request previews. The wildcard record for tenant sites is P2's.

The free-tier daily allowances are per account, not per Worker: 100,000
Hyperdrive queries, 100,000 KV reads and 1,000 KV writes, and 200,000 Workers Logs events at
three days of retention. All reset at 00:00 UTC. Nothing here bills.

### Switching a model

Both agents run through OpenRouter and read their model from a Worker secret: the Chief of
Staff from the api's `COS_MODEL`, the Developer from the orchestrator's `REME_MODEL_DEFAULT`,
and its fallback from `REME_MODEL_FALLBACK`. With none set, both agents run
`deepseek/deepseek-v4.1-flash` and the fallback is `x-ai/grok-4.6`.

```sh
pnpm model                                        # the models with a price
pnpm model developer z-ai/glm-5.3-flash           # staging, next build on
pnpm model cos deepseek/deepseek-v4.1-flash --production
```

The change applies from the next request, with no deploy. The script refuses a model with no
entry in `packages/facade/src/models/openrouter.models.json`, because spend is priced from
that table. To offer a new model, add its id to `openrouter.ids.json`, run
`pnpm --filter @workspace/facade models`, and merge and deploy that first.

### Every merge deploys

The commands above are the manual path and are no longer the normal one.
`.github/workflows/staging.yml` runs on every push to `main`, and on
`workflow_dispatch` when you want to put staging back in step by hand. In order: migrate the
Neon `main` branch through its direct endpoint, deploy `reme-api`, check `/health`, build and
deploy `reme-web`, check that the public page answers 200, then run `qa/e2e` against the
deployed app.

Migrations run before the Workers because migrations are expand/contract: the new schema is
safe under the code already deployed, and the reverse order is the pairing expand/contract
does not promise. `pnpm db:migrate` takes an advisory lock and prints `nothing to migrate` on
a second run, so a re-run costs nothing.

Both health checks exist because neither covers the other. `/health` asserts what `withOrg`
promises on a live connection, so it catches a role that gained `BYPASSRLS` and a migration
that dropped a policy. The web check is a plain 200 on `/`, which is what catches a deploy
that lost `WORKOS_REDIRECT_URI`: the AuthKit middleware validates config per request, so that
Worker answers 500 on every route while the api answers 200 throughout.

**Nothing rolls back automatically.** `wrangler rollback` moves code and not schema, so an
automatic rollback would pair the previous Worker with this run's migrations. It would also
make staging green while `main` was red, which is the drift the workflow exists to end.
A red run leaves staging serving the broken build, mails the owner through GitHub's default
Actions notification, and writes the two rollback commands into the run summary for a person
to decide on.

## Preview environments

Every pull request gets two URLs, in one comment that later pushes edit in place:

```
https://pr-<number>-reme-web.beapp.workers.dev
https://pr-<number>-reme-api.beapp.workers.dev
```

`.github/workflows/preview.yml` produces them with `wrangler versions upload --preview-alias
pr-<number>`. A version is uploaded rather than deployed, so it takes no production traffic
and leaves staging alone. It runs with the secrets already on the Worker, so the workflow
holds no WorkOS credential of its own. Previews stay on `workers.dev` because Cloudflare
issues preview aliases nowhere else.

Sign-in works on a hostname that changes every pull request because the staging WorkOS
environment carries one wildcard redirect URI,
`https://*-reme-web.beapp.workers.dev/api/auth/callback`. A WorkOS wildcard matches one
subdomain label, so the `-reme-web` suffix keeps it to this Worker and off the rest of the
shared subdomain. `reme-web` still has to know its own hostname: `--var` sets
`WORKOS_REDIRECT_URI` per version, because the AuthKit middleware validates that value on every
request and a deploy without a matching one answers 500 on every route.

Each pull request also gets a Neon branch, `preview/pr-<number>`, branched from `main` and so
already carrying the golden fixture orgs. The workflow applies the pull request's migrations to
it. That is more than the Postgres container in `ci.yml` can show, which starts empty: this runs
on Neon 17.11 over rows that already exist. Preview `reme-api` versions still read the staging
database, because pointing one at its own branch costs a Hyperdrive config per pull request and
the free plan allows ten per account.

The free plan allows ten branches per project and `main` is one, so nine previews can be open at
once. Closing a pull request runs the teardown job. It deletes that branch only when the
repository variable `PREVIEW_TEARDOWN` reads `on`, and prints what it would delete until then.

Four repository secrets, between this workflow and the staging deploy: `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, `NEON_API_KEY`, and `WORKOS_API_KEY`, which only the staging deploy
needs, for the throwaway account the smoke suite signs in as. The Cloudflare token needs
Workers Scripts Edit and Account Settings Read. Without them the first step fails and names
what is missing rather than skipping quietly.

## WorkOS environments

Redirect URIs, CORS origins and the homepage URL come from `scripts/workos.mjs`, applied
with the WorkOS CLI. One field is not in the CLI and is noted below.

```sh
workos env switch staging
pnpm workos:config staging
```

A second run changes nothing remotely and exits 0. The redirect URI and CORS lines say so and
read `unchanged`, which is the API's own answer rather than a local guess. The homepage line
always reads `set`: that call is an unconditional PUT of one field, with no prior value in its
response to compare against, and it is last-write-wins per environment.

The script is a floor, not a source of truth. Its CLI commands only add, so removing a line
here removes nothing in WorkOS, and a value deleted elsewhere comes back as `added` on the
next run. Removing one takes a different surface per resource. A redirect URI has a public
REST delete, reachable without leaving the CLI:
`workos api /user_management/redirect_uris/<id> -X DELETE`. A CORS origin has none, because
`/user_management/cors_origins` is GET and POST only, so that one needs `updateCorsConfig`
through the MCP server, which takes the whole list and can therefore shorten it. The default
redirect URI cannot be deleted at all.

One field is not in the CLI: the sign-in endpoint, which WorkOS calls the initiate login URI.
Set it with `updateAuthkitExternalLoginUri` through the MCP server, or in the Redirects tab of
the application in the dashboard. There is no matching read on either surface, so the script
prints the value it expects rather than checking it, and the dashboard is the only place the
current one is visible.

Two more fields are MCP-only and are **not set on staging yet**, so two flows behave differently
from how they read. `mfaEnabled` is `Off`, which means WorkOS never asks for a second factor at
sign-in: the enrolment page works and returns a real QR code, but the challenge page is
unreachable until it moves to `Optional`. `passwordResetUrl` is unset, so the reset email links
to the WorkOS-hosted page rather than to `/reset-password` here; our page works with any token,
it is the link in the email that points elsewhere. Both are one `updateAuthkitSettings` call
through the MCP server. `isMagicAuthEnabled` is `false` and no page here uses magic auth.

Prod needs its API key from the dashboard before the CLI can reach it:
`workos env add prod <api-key> --client-id=<client-id>`. It gets an entry in the script in
the change that gives it a hostname. In CI, `WORKOS_API_KEY` comes from a repository
secret and overrides the stored environment.

## Owner sign-in

Our own pages, not the WorkOS-hosted ones (DR-4a): `/sign-in`, `/sign-up`, `/verify-email`,
`/forgot-password`, `/reset-password`, `/mfa`, `/mfa-setup`, `/choose-organisation`,
`/sign-out`, plus `/api/auth/social` and `/api/auth/callback`.

`apps/web` owns the session (ADR-026). `authkitMiddleware` runs on every request from
`src/start.ts`; the pages post to `createServerFn` handlers in `src/lib/auth/`, which call
`@workos-inc/node` and seal the session there (ADR-024). No flow in that list touches the
database; `apps/api` reads the same sealed cookie for the flows that do.

The Worker reads `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_REDIRECT_URI` and
`WORKOS_COOKIE_PASSWORD` from its own bindings. Locally that is `apps/web/.dev.vars`, which
`pnpm bootstrap` writes and `.gitignore` covers. Deployed, the first three are wrangler
secrets set by `infra/bootstrap.ts` and the redirect URI is a `vars` entry in
`apps/web/wrangler.jsonc`, because it is a public URL rather than a secret and the AuthKit
middleware validates it on every request, the marketing page included.
`WORKOS_COOKIE_PASSWORD` is the same value on both Workers: it is the seal `apps/web` writes
and `apps/api` reads, so two values means `apps/api` sees every session as empty.
`pnpm check:secrets` scans the built `dist/client` and fails if any of them, or
`@workos-inc/node`, reaches a file a browser downloads.

Social sign-in is ours too, because the kit hard-codes `provider: "authkit"` and so can only
send someone to the hosted page. `/api/auth/social` builds the provider URL with the backend
SDK and writes a `state` cookie; `/api/auth/callback` matches it before exchanging the code.

## Design system

`packages/ui` is the app design system, and every primitive it exports carries a catalog
entry and an axe scan. A primitive missing from the catalog fails the suite that reads it.

```sh
pnpm --filter @workspace/ui catalog       # the catalog page; add ?theme=dark for the other one
pnpm --filter @workspace/ui test          # catalog drift, accessibility, and screenshots if you have baselines
pnpm --filter @workspace/ui test:update   # write the screenshot baselines for this machine
```

This suite runs locally, not in CI. It drives a real browser, and a runner that downloads
Chromium and its system dependencies on every run and then throws them away spent about a
minute doing it. `pnpm bootstrap` installs the browser, `pre-push` runs the suite, and CI
runs `pnpm test:ci`, which is every package except this one.

Screenshot baselines are gitignored on top of that: they are PNGs that every visual change
rewrites, and git keeps every version of each forever. Run `test:update` once per machine,
then `test` before a UI change and after it. Without baselines the two snapshot tests skip
rather than failing or silently writing new ones. They sit under
`test/__screenshots__/<platform>/`, because the same Chromium rasterises text differently
on macOS and on Linux.

Colour comes from the tokens in `packages/ui/src/styles/globals.css` and from nowhere
else. A hard-coded colour in a string or template literal in any `.ts` or `.tsx` file
fails `pnpm lint`, through the GritQL plugin in `scripts/lint/`: a Tailwind palette
class, a hex literal, a CSS colour function, or a named CSS colour. It does not read
`.css`, where the only stylesheet today is the token file itself, and it cannot see a
class assembled from pieces at runtime.

The plugin can fail open — a regex Biome cannot parse is reported at info level, which
does not fail a build — so `pnpm lint` runs `scripts/lint/colour-rule.mjs` first. That
lints a fixture with known answers and exits non-zero if the rule stops matching what it
is supposed to match, or starts matching what it is not.

## End-to-end smoke

`qa/e2e` walks the owner path in a browser: sign in, dashboard, org tree, the Chief of
Staff chat replay, the approvals inbox, plus a WCAG 2.2 AA scan of each assembled page.

```sh
E2E_BASE_URL=https://staging.remeai.co.uk pnpm e2e
E2E_BASE_URL=http://localhost:3000 pnpm e2e        # against your own `pnpm dev`
```

It runs on every merge to `main` against the staging deploy, as the last gate in
`.github/workflows/staging.yml`.

The suite names no environment. It takes a base URL and runs the same way against a local
dev server, staging, or a pull request's preview at
`https://pr-<number>-reme-web.beapp.workers.dev`. It needs `WORKOS_API_KEY` in
`.env.local` or in the environment, because it creates its own throwaway account on the
WorkOS staging environment and deletes it again in the teardown. The address is unique to
each run, which is also what keeps the sign-in rate limit (five per address per minute)
out of the way when you run the suite repeatedly.

Everything it asserts is a read. A preview deploy points at the staging database, so PRs
and staging share one set of rows and a scenario that wrote anything would collide as soon
as two PRs were open.

Traces are written on failure only, into the gitignored `test-results/`, along with the
sealed session cookie under `qa/e2e/.auth/`. Neither belongs in git.

## Conventions

- **Migrations are expand/contract only**; adding a tenant table without an RLS policy fails the build by design.
- Branches are `<type>/<short-kebab-summary>`; commits are conventional, imperative, subject line only. `.githooks/` enforces both locally once `pnpm bootstrap` has pointed `core.hooksPath` at it. They are advisory; review still happens on the PR.
- `pnpm size` bundles the worker with `wrangler deploy --dry-run`, gzips it, and checks the figure against the one wrangler prints for itself. It fails over the 1 MiB budget in `apps/web/size-budget.json`, and over a 2% drift from the baseline recorded there **in either direction**: a bundle that shrinks that far is a build that emitted less, not an improvement. A change that legitimately grows the bundle raises the baseline in the same PR, so the growth is visible in review. It measures the server bundle only, which is what wrangler's own total covers; static assets under `apps/web/public/` are uploaded separately and are not gated.
- Decisions that are expensive to reverse are recorded in `docs/adr/`, one file each.
- Requires Node ≥ 24 (see `.nvmrc`).

All rights reserved.
