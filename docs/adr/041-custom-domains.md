# ADR-041: Owners connect their own domain through Cloudflare for SaaS

Status: accepted, 2026-10-16. Applies to `apps/orchestrator`, `apps/router`, `apps/api`,
`packages/db`, `packages/contracts` and `infra/`. Amends ADR-030 (the `domains` reserved slug and
the production route `*/*`) and ADR-032 (served pages differ from the artifact by one origin
string, and the Cloudflare token stays in the orchestrator). Changes no DR: DR-5 already names
Cloudflare for SaaS for domains.

## Context

A published site lives on `{slug}.remeai.co.uk` (ADR-030). An owner who already has a domain
wants the site there, without moving their nameservers or their email, and without a person at
Reme doing anything. Their DNS is at GoDaddy, 123 Reg, their own Cloudflare account, or somewhere
we have never heard of. The site is a static artifact in R2 served by one router Worker from a KV
pointer, so a domain has to become one more pointer, not a deploy.

Buying a domain in the app is planned and parked. So is Domain Connect one-click, which waits on
Cloudflare's onboarding. This ADR covers connecting a domain the owner already holds, by records.

## Decision

**Cloudflare for SaaS custom hostnames on our zone, with the site router as the origin.** For each
domain the orchestrator creates two custom hostnames, `www.{name}` and the apex, with HTTP DCV
(`ssl: {method: "http", type: "dv"}`). The owner adds `www CNAME domains.remeai.co.uk`, and an
ALIAS at the apex if their provider has one; otherwise their provider forwards the apex to `www`.
Cloudflare issues and renews the certificate. `domains.remeai.co.uk` is a proxied `AAAA 100::`
fallback record, and the production router's route is `*/*`, which Cloudflare's "Workers as your
fallback origin" page documents as the route that catches custom hostname traffic. No apex A
record is ever offered: that needs apex proxying.

**Connecting is a `DomainWorkflow`, one instance per claim, `domain-{domain_id}`.** The CoS tool
`connect_domain` waits for the owner's approval, then reaches the orchestrator's
`POST /domains` over the owner binding (ADR-032, 2026-09-26). That route:

1. reads the domain's public DNS over DoH: the SOA for the zone apex (a subdomain other than `www`
   is refused), NS, the apex and `www` records, CAA and MX;
2. names the provider from Domain Connect discovery or the nameserver suffix, and offers a DNS
   settings link only from our own allowlist;
3. refuses an unpublished site, a fourth pending claim, and a name another org holds live (one
   unique index across orgs);
4. writes the claim `awaiting_dns` and starts the Workflow;
5. answers with the records to add.

The Workflow claims the two hostnames, then looks at once, on a `check` nudge, or after 2, 5,
15 and 30 minutes and hourly after that, for up to 72 hours. Each look is dub's verify order:
hostname unknown, a record in the way, hostname not verified, records pointing elsewhere,
certificate pending, valid. Ready means valid and the primary host answering through our edge.
A failed claim frees the name and deletes its hostnames.

**Postgres is the truth, KV the cache.** The `domains` row (migration 0015, RLS by org) holds the
state. Activation sets it `active`, then `writePointer` reads the active domain and writes three
pointers:

- `host:{primary}`, a `SitePointer` carrying `canonical_host` and `origin_host`;
- `host:{other half}`, a `RedirectPointer` to the primary;
- `host:{slug host}`, a `RedirectPointer` to the primary.

Every later publish writes the same three, so a domain survives a new revision and a rollback
without a step of its own. Thirty seconds after any state flip the pointers are written once
more, because the router's KV-miss path can write back a read from just before the flip. Removal
marks the row `removed`, drops the two domain pointers, points the slug host back at the site,
deletes the hostnames and ends the Workflow.

**The router serves any host with a pointer.** Order: service hosts pass through by name; a host
under the suffix takes the slug path; any other host reads `host:{host}`. A redirect pointer
answers 301 and keeps the path and query. A miss asks Postgres through `resolve_domain_host`, a
SECURITY DEFINER that answers active rows only and three columns. A slug host whose org has an
active domain redirects there even from Postgres, so an evicted key never puts the site back on
the old address. A host outside the zone with no pointer gets 404, never a pass-through, which
would fetch the `100::` fallback. Routes for fixed paths, such as Search Console's verification
file, go above the redirect, so a host that otherwise 301s still answers them.

**Served pages differ from the artifact by one origin string.** `astro build --site` bakes the
slug host into canonicals, `og:url`, the sitemap and robots. On a custom domain the router
replaces `https://{origin_host}` with `https://{canonical_host}` in `.html`, `.xml` and `.txt`
bodies, one `replaceAll`, and marks the ETag weak. Nothing else on a page changes.

**Takeover guard.** A record left pointing at us from an earlier claim would let a new claim on
the same name go live on DNS alone: Cloudflare's real-time validation activates a hostname whose
CNAME reaches the zone. RLS hides another org's removed and failed rows, so the claim cannot see
that history itself. Two signals set `needs_txt` on the new claim:

- `domain_held_elsewhere(name)` (migration 0016), a SECURITY DEFINER that answers one boolean:
  whether an org other than the caller's, read from `app.org_id`, ever held the name, in any
  state. With no context set, every row counts as another org's.
- The DoH inspection before the claim finds the apex or `www` already reaching us. On the owner's
  own Cloudflare only a visible CNAME counts, since a proxied record shows Cloudflare's addresses
  whatever it points at.

A `needs_txt` claim creates its hostnames in the connect route, before the Workflow starts so the
two never race, and stores each hostname's `ownership_verification` (`type: txt`, `name:
_cf-custom-hostname.{host}`, `value`) in `domains.ownership`. The records answer carries the TXT
records. A check that would otherwise pass verification stays `pending_verification` until public
DNS shows each host's TXT with its stored value. Cloudflare's `active` alone does not count,
because the API does not say which method activated a hostname. The check is ours, so it also
holds for an owner on Cloudflare, where Cloudflare's own TXT pre-validation is not supported.

**Credentials stay in the orchestrator.** `CF_DOMAINS_TOKEN` is an orchestrator secret, optional
in `infra/bootstrap.ts`. Without it, connecting answers `domains.not_configured` and nothing else
changes. `CF_DOMAINS_ZONE_ID` is a var, the same zone on staging and production. A hostname this
claim does not hold is refused, never adopted or deleted, so one environment never removes the
other's. The API, the sandbox and the Developer hold nothing that touches a hostname.

**Removal is the owner's.** `DELETE /domains/{name}` on the API is refused unless the caller's
membership is `owner`, then crosses the binding to the orchestrator's route. There is no CoS tool
for it.

**A daily look at live domains.** The hourly sweep (ADR-032), at 06 UTC, reads each active
domain's primary hostname. Cloudflare's `moved`, or a certificate no longer active, raises one
`alert.raised` and posts one message to the owner. The check is stored with the alert in one
transaction, so the next day's sweep finds no change and raises nothing. A hostname Cloudflare no
longer has raises the alert only.

## What was rejected

- **A rebuild per domain** with the domain as `--site`. A rollback would bring the slug canonical
  back, and every domain change would cost a build.
- **Asking owners to move nameservers to us.** Email breaks on a missed record, it takes a day or
  two, and DNSSEC has to be turned off first.
- **A Worker custom domain per tenant.** It puts a Cloudflare API write and its limits on the
  publish path and needs the domain in our account.
- **A separate publisher Worker for the token.** ADR-032 said the publisher would move to its own
  Worker when it needed a Cloudflare credential. The token's grants are custom hostnames on one
  zone. The orchestrator already writes every routing pointer, and a second Worker would add a
  deploy and a binding to guard one secret the sandbox cannot reach either way.
- **Trusting Cloudflare's `active` for a guarded claim.** It may come from the CNAME the guard
  exists to distrust.

## Consequences

- The `domains` slug is reserved (ADR-030, amended).
- The production router owns `*/*`, and every service Worker keeps its explicit host route
  (ADR-030, amended).
- A connected domain needs the owner's one-time Cloudflare setup on production: Cloudflare for
  SaaS on `remeai.co.uk`, the `domains.remeai.co.uk` fallback record, and the token. Until then
  the code runs and refuses as not configured.
- A guarded claim asks the owner for two TXT records more. An owner reconnecting a domain their
  own org once removed is guarded too when its old record still points at us.
- `domain_held_elsewhere` tells any org that can make a claim whether a name was ever connected
  to Reme, one boolean, nothing about whom. That is the price of the guard.

## Change if

Cloudflare's API starts reporting how a hostname was validated, which would let the TXT check
move to Cloudflare; a second environment needs its own SaaS zone; buying ships, which adds its
columns and states in an expand migration and Registrar grants to the token; or Domain Connect
onboarding lands, which adds the one-click path beside the records path.
