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
pnpm dev
```

It is `preflight` rather than `doctor` because pnpm has a built-in `doctor` command that
would shadow the script and report `All checks passed` without running any of ours.

`pnpm bootstrap` is safe to run again: every step is a no-op once it has been done. It is
also the only thing that sets `core.hooksPath`, so a clone that skips it runs no hooks at
all, meaning no commit-subject check and no secret scan.

Postgres is a Neon branch by default. Without one, set `NEON_OFFLINE=1` in `.env.local`
and take the offline `DATABASE_URL` from the comment in `.env.example`, then run
`pnpm bootstrap` again to start the pgvector container in `docker-compose.yml`.

Secrets never enter a committed file. `.env.example` carries names and shapes,
`.env.local` carries values and is gitignored, and `packages/config` validates both so a
missing one fails at boot naming the variable.

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
`@workos-inc/node` and seal the session there (ADR-024). There is no `apps/api` in this repo
yet and nothing here needs one: no flow in the list touches the database.

The Worker reads `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_REDIRECT_URI` and
`WORKOS_COOKIE_PASSWORD` from its own bindings. Locally that is `apps/web/.dev.vars`, which
`pnpm bootstrap` writes and `.gitignore` covers; deployed it is `wrangler secret put`.
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

## Conventions

- **Migrations are expand/contract only**; adding a tenant table without an RLS policy fails the build by design.
- Branches are `<type>/<short-kebab-summary>`; commits are conventional, imperative, subject line only. `.githooks/` enforces both locally once `pnpm bootstrap` has pointed `core.hooksPath` at it. They are advisory; review still happens on the PR.
- `pnpm size` bundles the worker with `wrangler deploy --dry-run`, gzips it, and checks the figure against the one wrangler prints for itself. It fails over the 1 MiB budget in `apps/web/size-budget.json`, and over a 2% drift from the baseline recorded there **in either direction**: a bundle that shrinks that far is a build that emitted less, not an improvement. A change that legitimately grows the bundle raises the baseline in the same PR, so the growth is visible in review. It measures the server bundle only, which is what wrangler's own total covers; static assets under `apps/web/public/` are uploaded separately and are not gated.
- Decisions that are expensive to reverse are recorded in `docs/adr/`, one file each.
- Requires Node ≥ 24 (see `.nvmrc`).

All rights reserved.
