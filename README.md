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

## Conventions

- **Migrations are expand/contract only**; adding a tenant table without an RLS policy fails the build by design.
- Branches are `<type>/<short-kebab-summary>`; commits are conventional, imperative, subject line only. `.githooks/` enforces both locally after `git config core.hooksPath .githooks` — a fresh clone does not run them until you do. They are advisory; review still happens on the PR.
- Requires Node ≥ 24 (see `.nvmrc`).

All rights reserved.
