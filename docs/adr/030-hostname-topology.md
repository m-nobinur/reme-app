# ADR-030: One hostname for the app, one per tenant for the site

Status: accepted, 2026-08-30. Applies to `apps/web`, the C7 website plane, `infra/`, DNS on
`remeai.co.uk`, and the story that lets an owner choose a slug.

Changes no DR. It settles the hostnames the plans left as placeholders (`mypareme.app`,
`reme.app`, `{rev}.preview.reme.app`), all of which are replaced by `remeai.co.uk`, the one domain
this account holds.

## Context

Two surfaces want a hostname and they want opposite things.

The **owner app** is the authenticated console a business owner runs their assistant from. The
**tenant site** is the public marketing site the assistant builds for that business, indexed by
search engines and visited by that business's customers. Treating these the same way is the
mistake worth avoiding: one wants a single origin and the other wants one origin per tenant, for
reasons that do not overlap.

A third surface, the revision preview, is the site plane's and inherits the site plane's answer.

## Decision

**The owner app is one hostname for every business.** `preview.remeai.co.uk` before launch,
`app.remeai.co.uk` after. Not per-tenant.

**A tenant site is one hostname per business**, `{slug}.remeai.co.uk` by default, and the
business's own domain when they are ready.

**Revision previews are `preview-{rev}.remeai.co.uk`**, flat rather than nested.

## Why the app is not per-tenant

The tenant is already resolved server-side from the `org_id` claim inside the sealed session
(§9.2 layer 1, ADR-024, ADR-029). Putting the tenant in the hostname would mean the tenant is
also, and first, in client input. R3 says `org_id` never comes from client input, and a `Host`
header is client input. A per-tenant app hostname does not merely fail to help, it creates a
second and weaker path to the answer the session already carries, and the two can disagree.

The rest follows from that and is ordinary:

- **Auth.** One redirect URI, one cookie, one origin. Per-tenant app hostnames need a wildcard
  redirect URI, which is a broader registration than a single host, and cookie scoping across
  sibling subdomains is a class of bug this codebase has no reason to invite.
- **Switching.** An owner with two businesses switches inside the app. The switcher exists and
  reads the session. Per-tenant hostnames turn that into a navigation and a re-auth.
- **Operations.** One Worker, one certificate, one deploy, one cache.

## Why a tenant site *is* per-tenant

Every reason is a reason the app does not have:

- **Search.** `1-product.md` says the website plane exists because small businesses lose leads
  that never arrive. That is a local-SEO claim. Each business needs its own origin for indexing,
  its own `sitemap.xml`, its own `robots.txt` and canonical URLs. A path-based `/sites/{slug}`
  pools every tenant's authority into one domain and is materially worse at the one job this
  plane has.
- **Isolation.** End-customer sessions on the tenant site are scoped to the tenant hostname (§).
  Separate origins are what makes that true rather than aspirational.
- **Trust.** A cleaning company hands out their own address, not a path on ours.

## Why one level deep, and what it costs

`{slug}.remeai.co.uk`, not `{slug}.sites.remeai.co.uk`. Free Universal SSL covers the apex and
**first-level subdomains only**; a second level needs Advanced Certificate Manager at $10/month or
an uploaded wildcard certificate that somebody has to remember to renew. `preview-{rev}` is flat
for the same reason, which is why it is not `{rev}.preview`.

The cost of one level is that tenant slugs share a namespace with our own hostnames, so the
reserved list is not optional: `app`, `www`, `api`, `admin`, `mail`, `staging`, `preview`, `docs`,
`status`, and the `preview-` prefix. That list belongs in the same change as the first
owner-chosen slug and nowhere earlier, because nothing chooses a slug today.

## How it is served

**One Worker for every tenant site, routed by `Host`.** A wildcard route `*.remeai.co.uk/*` on a
single `reme-sites` Worker, with one wildcard DNS record. Not a Worker or a DNS record per tenant:
that would put a Cloudflare API write on the signup path, with its rate limit, its propagation
delay and its failure mode, in exchange for nothing. Signup stays a database write.

**Serve artifacts, not queries.** The publisher writes an immutable rendered revision to R2 keyed
by `(org_id, revision)`, and a KV pointer names the live revision per host. A request reads the
pointer and streams the artifact. Publishing flips a pointer, which is what makes M4's "rollback
under 60 s" a pointer write rather than a rebuild. It also keeps the `/staff` lesson from
repeating: that read measured 82 ms of fixed cost before a row was returned, and a marketing page
is the most cacheable thing in the product.

**Custom domains are Cloudflare for SaaS**, when a business is ready. The business points a CNAME
at us and Cloudflare issues and renews the certificate. That is a paid feature and a Phase 4
decision; nothing before then needs it.

## What this does not decide

Whether tenant sites and the owner app share a Worker. They should not, but that is C7's shape and
C7 does not exist. This ADR fixes the hostnames so C7 is not designed around a placeholder.

## Consequences

- `1-product.md`, `2-architecture.md` and `5-delivery.md` lose `mypareme.app` and `reme.app`,
  replaced 2026-08-30.
- The reserved-slug list becomes a requirement of the owner-chosen-slug story, which is where
  uniqueness stops being guaranteed by construction. Today `slugFor()` appends eight characters of
  the org id and `orgs_slug_unique` is the backstop, so no two businesses can collide; an
  owner-chosen slug removes the first guarantee and leaves only the second.
- Nothing in Phase 1 changes. No tenant site exists, and the only hostname this phase needs is the
  app's.
