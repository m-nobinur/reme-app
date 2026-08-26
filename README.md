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
pnpm run doctor   # names what is still missing and the command that fixes it
pnpm dev
```

`pnpm run doctor` needs the `run`: pnpm has a built-in `doctor` command of its own,
and `pnpm doctor` reaches that one instead.

`pnpm bootstrap` is safe to run again: every step is a no-op once it has been done. It is
also the only thing that sets `core.hooksPath`, so a clone that skips it runs no hooks at
all, meaning no commit-subject check and no secret scan.

Postgres is a Neon branch by default. Without one, set `NEON_OFFLINE=1` in `.env.local`
and take the offline `DATABASE_URL` from the comment in `.env.example`, then run
`pnpm bootstrap` again to start the pgvector container in `docker-compose.yml`.

Secrets never enter a committed file. `.env.example` carries names and shapes,
`.env.local` carries values and is gitignored, and `packages/config` validates both so a
missing one fails at boot naming the variable.

## Conventions

- **Migrations are expand/contract only**; adding a tenant table without an RLS policy fails the build by design.
- Branches are `<type>/<short-kebab-summary>`; commits are conventional, imperative, subject line only. `.githooks/` enforces both locally once `pnpm bootstrap` has pointed `core.hooksPath` at it. They are advisory; review still happens on the PR.
- Decisions that are expensive to reverse are recorded in `docs/adr/`, one file each.
- Requires Node ≥ 24 (see `.nvmrc`).

All rights reserved.
