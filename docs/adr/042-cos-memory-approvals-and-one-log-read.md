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

**One log read per turn.** The turn's first transaction reads the session whole once, after its
`cos.context` is written and under the same lock, and passes the rows through `AgentTurn`, so it
costs no transaction of its own. `settle` and `startModel` work from those rows; `settle` reads
again only after it ran a call, and leaves the rows caught up. `prepareStep` reads only events after
the last sequence it holds (`readSessionSince`), appends them, checks the hash and writes the
step's `cos.call`, all in one transaction. The integrity check is unchanged in what it proves: the
hash still covers the whole derived message list, and the call is refused on any mismatch. It holds
because the turn is the only writer to its session while it holds its token and the conversation
lock, so the rows it holds plus the rows after its last sequence are the log. The workspace load
(status, domains and facts in one transaction) starts beside `lookAhead`, and its facts give the
persona, so the second fact read goes. An onboarding turn starts the load too and drops it, since
`lookAhead` is what says which kind of turn it is. This replaces ADR-034's "each model call costs
one extra read of the session's events".

**Approvals are bound.** For each approval request `onStepEnd` appends
`cos.approval {turn_id, approval_id, tool_call_id, input_sha256, expires_at}` in the same write as
its `cos.step`, so a logged step always has its cards' records. The answer is checked in `openCos`
and again in `runTool` before execute: another call id, a different input hash or a passed expiry
is refused. The call closes as `output-error` with a line that starts `APPROVAL_EXPIRED` (from the
contracts), the model reads it and tells the owner, and the card shows "expired" for every one of
these reasons. A card with no record, shown before this change, is refused the same way. Expiry
is written and checked on the Worker's clock: a day is long enough that seconds of skew do not
matter. CoS acts expire after 24 hours; publish approvals keep ADR-032's 72. When an act tool
throws a `ToolFailed` that is not an answer off the contract, its outcome is unknown: `runTool`
appends `cos.tool_unknown {tool_call_id, approval_id}`, `settle` closes the call with the unknown
line, and the turn goes on to the model, which asks the owner. This replaces ADR-034's 503 that
left the call open to run again. Every act call is checked and marked in one transaction before
it runs: the log is caught up, the approval checked, and `cos.tool_started {tool_call_id,
approval_id}` appended. A start with no result five minutes later, by the database's clock, is a
Worker killed mid-call: the next `runTool` appends `cos.tool_unknown` instead of running it. A
start younger than that is run again under its key, which replays it, as ADR-034 had it. `runTool`
refuses any call the log marks unknown, matched by call id and approval id together, since
provider call ids repeat across turns. Other errors keep ADR-034's path: the turn ends as an error
and the next turn replays the call under its approval key. A card answered twice runs its tool
once: the second answer finds the conversation busy or the card already resolved.

Only `request_change` acts on a versioned target, the live site, so its card's hash covers
`{input, site_version}`, the version from the latest deployment when the card is shown and again
when it is answered: a publish in between refuses the yes as expired. `answer_question`,
`create_reminder`, `record_review`, `connect_domain` and `remove_domain` act on targets the input
names in full, so their hash covers the input alone. Both events sit outside
`deriveCosMessages`, which ignores types it does not know, so the model's view and the integrity
hash do not change.

**A typed yes over a card**, owner decision 2: allowed only for `create_reminder` and
`request_change`, exact phrases first, then Jev, while creative builder's CM2 keeps Jev. Domain,
review and Developer-answer cards keep ADR-034's rule: a typed message cancels them. An emailed
"yes" approves nothing.

- **Which card.** `lookAhead` reads the tail for a typed message: its last step holds exactly one
  pending call, and it is one of those two cards. Two pending cards, or any other tool, and the
  message takes the normal turn. The tail is the message a click answers, so a card behind a later
  row is out of reach. That also gives one card to answer without a "superseded" state: a typed
  message cancels the open card before the CoS can propose another, and an emailed reply is not
  stored while a card waits (`postOwnerEmail` returns `waiting`).
- **What counts.** A whole reply that is one short phrase (`PHRASES` in `jev.ts`: yes, yes please,
  go ahead, do it, ok; no, no thanks, don't, cancel, stop), ignoring case and punctuation. Anything
  longer, "yes but make it 5pm" included, is never an approval and takes the normal turn, where the
  CoS proposes a new card. Otherwise, while Jev is available, one call with three `noul` questions:
  approves it, declines it, asks for a change. A false yes runs a tool and a false null costs a
  turn, so the deciding question must reach `JEV.sure` (0.9), the other two must be at most 0.1,
  and a change request beats an approval. Unsure, a Jev error or a timeout is the normal turn. If
  CM2 drops Jev from the chat, `readReply` is left with its phrase half and nothing else changes.
- **The same path as a click.** The turn resolves the card with the code a results turn uses
  (`resolveApprovals`): the version binding, the 24 hour expiry and the `cos.tool_started` mark
  all apply, so a typed yes on an expired or changed card is refused with the same line. The
  owner's words are then logged as their message and the model answers in a new message, so it
  says what ran. With no model, one line says how the reply was read ("Taken as a yes: ..."). The
  stream carries only the new message, so the web, which cancels a pending card on screen when
  the owner types (`cancelOvertaken`), shows this one as cancelled until it reloads.

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

**Redaction before every model call.** §14.2 promised it and nothing did it. The flue tee's
`scrub` in `packages/facade` is exported, so there is one scrub and one list of secret shapes, and
the api imports it from `@workspace/facade/tee`: the package root would pull the whole facade
into the api Worker, about 755 KB minified against 230 bytes. The CoS runs it in `prepareStep`,
which every model call passes through, over every string in the messages except provider data,
and sends the model the redacted list. Both sides of the integrity check are hashed redacted:
the SDK's messages and the messages derived from the log. Redacting inside `deriveCosMessages`
instead was rejected: the SDK carries its own copy of each step's output into the next call, so
the two sides would differ on any step that returned a secret-shaped string, and the derivation
would stop being a plain function of the log. Scrub is idempotent, so a list the SDK carries over
from a redacted step hashes the same again. The hash, and the `cos.call` that logs it, now prove
the model saw the redaction of the derived log, which is what it was sent. Two lists that differ
only inside a secret-shaped string hash alike; the model sees the same text either way. The log
keeps the words as they were said and returned: redaction is at the model boundary, not before
append. That is the answer to §14.2's "before event append" half: the log is the system of
record, and a replay must see what the owner and the tools said, so the scrub runs where text
leaves for a provider instead. The other api model calls run the same scrub over what they send:
Jev's question state, the onboarding planner's turn data and the background copy call's prompt.
Compaction and reflection must call it too when they send a transcript.

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
