# evals

The §16.3 eval suites. `pnpm eval [--tier 1|2|3]` runs them; CI runs `--tier 1`.

## What a run does

Two passes.

1. Every fixture in `fixtures/` is replayed twice and both hashes are checked
   against the one the fixture is pinned to. A scenario scored against a context
   that drifts between runs is scoring noise, so this comes first and a failure
   stops the run.
2. The tier's scenarios run. Each is a `tier-<n>/*.eval.mjs` whose default
   export throws on failure.

There are no scenarios. The runtimes they would score land in Phase 3, so the
tier directories do not exist yet: the PR that writes the first scenario creates
its directory. An absent tier reads as zero rather than as an error.

| Tier | What it covers |
| --- | --- |
| 1 | Contract: schema-valid role output, InformationRequest rather than fabrication |
| 2 | Pack: cleaning quote math, schedule constraints, service-area edges |
| 3 | End-to-end: golden assignment on a fixture org, fabrication count 0 |

## Fixtures

`pnpm record` writes `fixtures/cos-chat.jsonl` from the mock Chief of Staff
conversation the chat surface streams. Line 1 is the header and carries the
hash; every other line is one recorded chunk. Re-record when the recording
changes and read the diff, which is what a golden fixture is for.

It is committed, at 13 KiB of text, against the rule that recorded fixtures stay
out of git. The rule is about blobs git can only store whole: one line per chunk
means a word change is a one-line diff, and a fixture nobody can read in a
review is not golden.

`record.mjs` is the only file here that reaches into `apps/web`, and it runs by
hand rather than in CI. Point it at the real runtime when there is one.

## The hash

`deriveContext` folds a recorded chunk stream into the model-visible state of
the session: text, reasoning, and each tool call with its input, its approval
and its output. `canonical` serialises that with every key sorted. The hash is
sha256 over those bytes.

Nothing in the path reads a clock, a random source or the environment, and
`delayMs` is dropped at record time because a number nothing reads is a number
someone will eventually hash. Parts come out in stream order and the lookup maps
are never iterated.

Six deliberate breaks were tried and five went red. One word changed in the
fixture, a fold that assigns text deltas instead of appending them, a fold that
drops the approval, `canonical` with its sort removed, and `Math.random()` in
the derived context. Only the last of those fails the replayed-twice check; the
other four fail against the pinned hash.

The sixth stayed green. Disabling the `reasoning-start` branch changes nothing,
because the delta branch reopens the part at the same position, so on this
recording the two are the same fold. That is a fair coincidence rather than a
hole, and it is written down here so nobody reads the green as coverage.

## Langfuse

`langfuse.mjs` is a seam, not an integration. Off unless `LANGFUSE_SECRET_KEY`
is set, which nothing sets. §31.2 is the pipeline it becomes.
