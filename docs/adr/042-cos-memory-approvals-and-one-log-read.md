# ADR-042: The Chief of Staff reads its log once, binds approvals, and keeps memory without a new runtime

Status: proposed, 2026-10-19. Applies to `apps/api` (`src/cos/**`, `src/chat.ts`),
`packages/contracts` and `packages/db`. Amends ADR-034. Owner decisions of 2026-10-19 settle the
memory trigger and the typed-approval scope; the rest follows from the follow-through plan
(`.local/research/follow-through-plan.md`).

## Context

ADR-034 made the CoS an AI SDK agent whose every model call is checked against messages derived
from the session's event log. Three things in it no longer fit.

- **Speed.** A turn reads the whole log three times before its first token and once more per tool
  step. Measured on staging on 2026-10-19: first-token p50 3.3 s and p95 7.7 s against the §16.2
  target of p95 under 3 s, with 8 transactions before the model call.
- **Approvals.** A card approved now runs whatever input the tool call carries when the answer
  arrives, however old the card. A write whose outcome is unknown can be settled again.
- **Memory.** The CoS forgets everything past a 12-turn window. ADR-034's first change-if moves the
  CoS to a flue `lite` runtime as soon as a tool reads memory, and another one says any caller
  other than the owner's turn taking the conversation lock forces a two-transaction approval.
  Memory and background work trip both.

## Decision

**One log read per turn.** `startModel` reads the session once and passes the rows through
`AgentTurn`. `prepareStep` reads only events after the last sequence it holds
(`readSessionSince`) and appends them. The integrity check is unchanged in what it proves: the hash
still covers the whole derived message list, and the call is refused on any mismatch. It holds
because the turn is the only writer to its session while it holds its token and the conversation
lock, so the rows it holds plus the rows after its last sequence are the log. The workspace load
starts beside `lookAhead`, the domains query folds into the status read, and the second fact read
goes. This replaces ADR-034's "each model call costs one extra read of the session's events".

**Approvals are bound.** For each approval request `onStepEnd` appends
`cos.approval {turn_id, approval_id, tool_call_id, input_sha256, expires_at}`. The answer is
checked in `openCos` and again in `runTool` before execute: a different input hash or a passed
expiry is refused with a fixed line, and the card shows "expired". CoS acts expire after 24 hours;
publish approvals keep ADR-032's 72. A call whose outcome is unknown appends
`cos.tool_unknown {tool_call_id, approval_id}`. Settle never runs it again; the owner is asked.
Both events sit outside `deriveCosMessages`, which ignores types it does not know, so the model's
view and the integrity hash do not change.

**A typed yes over a card**, owner decision 2: allowed only for `create_reminder` and
`request_change`, exact phrases first, then Jev's `noul` questions at the existing thresholds,
while creative builder's CM2 keeps Jev. Domain, review and Developer-answer cards keep ADR-034's
rule: a typed message cancels them. An emailed "yes" approves nothing.

**Memory does not move the CoS to the lite runtime**, owner decision 4. The owner profile is one
fact, `owner.profile`, at most 1,500 characters, written with `supersedeFact` and injected as
untrusted data with a fullness marker. Compaction is a `cos.compaction` event (§10.6) that
`deriveCosMessages` folds in, so the derivation, and with it the integrity check, still reproduces
exactly what the model saw. ADR-034's first change-if now reads: the delivery plan's lite-runtime
row, or the first CoS tool that reads documents or skills.

**Background callers take the lock, and that is safe.** The after-turn job writes compaction with
`writeAsTurn` under the conversation lock, after the owner's turn has closed; the heartbeat posts
through `postAssistantMessage`, which already defers to a busy conversation. Neither runs a model
call inside the lock: the summary is written first and only appended under it. ADR-034's lock
change-if is narrowed to: a model call runs inside the lock, the approval turn's p95 passes 5 s,
or a Hyperdrive connection-count alarm fires.

**Redaction before every model call.** §14.2 promised it and nothing did it. A text-level scrub
from `packages/facade` runs over every message the CoS, compaction and reflection send to a model,
with the same secret shapes the flue tee uses.

## What was rejected

- **Moving the CoS to flue now.** flue's compaction is not proven reproducible from our log, which
  the integrity check needs, and the approval cards and the hash check would be rebuilt.
- **Dropping the integrity check to save the reads.** It is the only proof that the model saw the
  log and nothing else; the incremental read keeps the proof and drops the cost.
- **Approval by tool call id.** Provider ids are not unique across turns; ADR-034 already keys acts
  by approval id.
- **Proposals the owner approves for every memory write** (§25.1 as written). Owner decision 3:
  reflection writes the profile directly, shows the change, and one tap undoes it.

## Consequences

- A turn makes fewer round trips before its first token; the staging rerun of the baseline records
  how many and the new p95.
- An old card cannot run against a changed site. An owner who waits a day re-asks.
- The profile and compaction events become model-visible state that the eval set must cover.

## Change if

The incremental read ever disagrees with a full read in the integrity check (go back to full
reads and find the second writer); a compaction drops an open approval or a seeded fact in the
60-turn eval; or the owner wants approvals by email.
