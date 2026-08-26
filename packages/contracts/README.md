# @workspace/contracts

Every payload that crosses a team boundary. Zod schemas are the source; the
JSON Schema and OpenAPI document under `generated/` are built from them and
committed, so a consumer in any language reads the same shape TypeScript does.

This package imports nothing from the repo. That is the anchor of the
dependency direction, not a coincidence.

## Changing a contract

1. Edit the schema in `src/`, and add it to `src/registry.ts` if it is new.
2. `pnpm generate`, then commit `generated/` in the same PR.
3. `pnpm test`. Every contract in the registry needs a sample in
   `test/samples.ts`; the suite fails without one.

`pnpm check:drift` regenerates and fails if the committed output moved. It runs
on every PR, so step 2 is not optional. Never hand-edit anything in
`generated/`; the pre-commit hook rejects it.

## Rules the shapes follow

**Strict objects everywhere.** An unknown key is a validation error, not
silently dropped data. This is what makes the Zod schema and the emitted JSON
Schema mean exactly the same thing, and the fuzz suite asserts that agreement
on every field of every contract. The cost is lockstep: a producer sending a
field its consumer has not deployed yet gets rejected. That is the intended
trade while contracts change by PR with every consumer reviewing.

**No `.default()`.** A default makes the input and output schemas differ, which
means one contract would emit two JSON Schemas. Defaults are the producer's
business.

**No `z.date()`, no `bigint`.** These have no JSON representation. Timestamps
are RFC 3339 strings with an offset; ids are UUIDs or ULIDs.

**Discriminated unions, never optional fields that mean different things.** See
`ApprovalTarget`: four kinds, each carrying only its own fields.

**Refs, not bodies.** Anything crossing a durable boundary carries an id.

**snake_case field names**, matching the Postgres columns and the architecture
document.

## Known gap: `__proto__`

`{"__proto__": ...}` is valid JSON, and `JSON.parse` turns it into an ordinary
own key without touching the prototype. The published JSON Schema rejects it,
correctly. Zod 4.4.3 accepts it and strips it, so nothing is polluted, but a
consumer validating against our OpenAPI document would reject a payload our own
runtime waves through. The gap is exactly one key wide: every other inherited
name is rejected by both, and the suite asserts that.

Whatever terminates TLS is the right place to drop the key outright. Until
then the divergence is pinned by a test that fails when Zod fixes it.

## Versions

`zod` and `openapi-typescript` are pinned exactly. Both decide the bytes in
`generated/`, so a floating minor would turn the drift check red on a PR that
changed nothing.

The fuzz seed is pinned too, so the suite is a pure function of its inputs and
a cached pass means what it says. The cost is a fixed set of cases: new ground
gets covered when the schemas change, not when the clock moves. A random-seed
sweep belongs in the nightly job.
