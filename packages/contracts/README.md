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

Step 2 is not optional, and the suite is what holds you to it.
`test/drift.test.ts` rebuilds the document in memory and fails if it does not
match the committed `generated/openapi.json`. It runs wherever `pnpm test`
runs, so a stale file fails on your machine before it reaches a PR.
`pnpm check:drift` is the same check in writing form, for when you would
rather have the file fixed than be told about it. Never hand-edit anything in
`generated/`; the pre-commit hook rejects it.

## Rules the shapes follow

**Strict objects everywhere.** An unknown key is a validation error, not
silently dropped data. This is what makes the Zod schema and the emitted JSON
Schema mean exactly the same thing, and the fuzz suite asserts that agreement
structurally, on every field of every contract. The cost is lockstep: a
producer sending a field its consumer has not deployed yet gets rejected. That
is the intended trade while contracts change by PR with every consumer
reviewing.

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

## Known gaps

### `__proto__` is accepted by Zod and rejected by the JSON Schema

`{"__proto__": ...}` is valid JSON, and `JSON.parse` turns it into an ordinary
own key without touching the prototype. The published JSON Schema rejects it,
correctly. Zod 4.4.3 accepts it and strips it, so nothing is polluted, but a
consumer validating against our OpenAPI document would reject a payload our own
runtime waves through. The gap is exactly one key wide: every other inherited
name is rejected by both, and the suite asserts that.

Whatever terminates TLS is the right place to drop the key outright. Until
then the divergence is pinned by a test that fails when Zod fixes it.

### The fuzz suite catches structural divergence, not value constraints

Mutations come from `fc.jsonValue()`, which lands on the narrow band between
two value constraints roughly never. A tightened `minLength`, an enum member
present in one schema and not the other, or a dropped `minimum` are not
reliably caught; a field that appears, disappears, or changes type is. The
drift test covers the case that matters in practice, which is a schema edit
that never got regenerated. Closing the gap properly means deriving candidate
values from each leaf's own constraints, and that is its own change.

### `openapi-typescript` wants a TypeScript it does not get

`openapi-typescript@7.13.0` declares `peerDependencies: {"typescript": "^5.x"}`
and the repo runs 6.0.3, so an install prints an unmet peer warning. It works,
and the output is byte-stable, but this package decides the bytes in
`generated/` and the mismatch is worth knowing about before a version bump.

## There is no generated client yet

`paths` in the OpenAPI document is empty, so `generated/openapi.d.ts` gives you
`components["schemas"][...]` and an empty `paths`. That is deliberate: no
service exists to describe. A client becomes worth generating the moment
`apps/api` declares its first route; until then a typed wrapper would have
nothing to call, and the mock server FE builds against has nothing to mock.

## Versions

`zod` and `openapi-typescript` are pinned exactly. Both decide the bytes in
`generated/`, so a floating minor would turn the drift check red on a PR that
changed nothing.

The fuzz seed is pinned too, so the suite is a pure function of its inputs and
a cached pass means what it says. The cost is a fixed set of cases: new ground
gets covered when the schemas change, not when the clock moves. A random-seed
sweep belongs in the nightly job.
