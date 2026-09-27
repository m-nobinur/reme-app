# ADR-034: The Chief of Staff is an AI SDK agent in the api, with history from the event log

Status: accepted, 2026-09-27. Applies to `apps/api`, the chat in `apps/web`, `packages/contracts`
and `packages/db`. Changes no DR. It makes one scoped exception to §6.3 and DR-9 for the Chief of
Staff (CoS). It ends on whichever trigger in the first item under "Change if" fires first.
Amended 2026-09-27: what a timed-out bridge call means, and the limits that follow from it.
Amended again the same day: the budget lock and the stream. Brought in line with the tools, the
event appends and the history derivation on 2026-09-28, and marked where the agent's PR adds the
rest.

## Context

The owner's chat already runs on `POST /chat` in `apps/api`, with no model. A script asks for each
missing fact with an `ask_fact` tool call, offers the first build as a `request_change` approval,
and afterwards turns a message typed in Act mode into another change card. It writes the AI SDK's
SSE frames by hand and imports only types from `ai`. History lives in `conversation_messages`, and
an answer or an approval rewrites the tail assistant row by compare-and-swap, because ai 7
continues the last assistant message rather than starting a new one.

A model can take over from the script, but four things in the shipped code stand in the way:

1. §10.6 and R7 require every model request to be a pure function of the append-only log.
   `conversation_messages` is mutable, so it cannot be that log.
2. `ChatRequest` carries one answer or one approval per turn. The AI SDK sends once every pending
   call in the last step is resolved, and a model can make several calls in one step. The SDK's
   approval response also carries an optional `reason` that the contract drops. And `AskFactInput`
   is a union at its root, which provider tool APIs refuse as tool parameters.
3. `tool_call_id` follows the message-id rule `^[A-Za-z0-9_-]{1,64}$`, which refuses ids some
   providers emit, such as `functions.ask_fact:0`.
4. `bridge()` in `apps/api/src/owner.ts` has no timeout, no database statement or
   idle-in-transaction timeout is set, and the script's approval holds the conversation's row lock
   across the bridge call.

Every `ai` behaviour this ADR relies on was read in the installed 7.0.83, and the file and line are
given where it matters.

## Decision

### The agent

`apps/api/src/cos/agent.ts` is a `ToolLoopAgent` from `ai` 7.0.83, pinned exactly.

- `callOptionsSchema` takes the mode (`ask` or `act`), the turn's context text, and the session's
  org, user, session and conversation ids. `prepareCall` sets `activeTools`, places the context
  message, and moves the ids into `runtimeContext`. It reads nothing itself. The ids never enter
  instructions, messages or a tool input, so the model has no way to name another tenant.
- Ask mode gets the read tools only. Act gets all of them.
- `toolApproval` is set on the agent as a map keyed by tool name, as `index.d.ts:3071` and `:5056`
  define it. The tool-level `needsApproval` is not used.
- `stopWhen: isStepCount(6)` and a per-step `maxOutputTokens` of 1,000, a guess that the agent's
  PR replaces with three times the measured p95 output of 20 staging turns.
- `timeout: {totalMs: 60_000, firstChunkMs: 10_000}`. Both are guesses: six steps of about ten
  seconds, and ten seconds to a step's first chunk. The agent's PR sets `firstChunkMs` to three
  times the measured first-chunk p95 and `totalMs` to six times that. `firstChunkMs` applies to
  every step, not only the first.
- The model comes from `COS_MODEL`, default `deepseek/deepseek-v4.1-flash`. That id is in
  `packages/facade/src/models/openrouter.ids.json` today, and a unit test keeps it there. The agent
  reaches it through OpenRouter with `OPENROUTER_API_KEY`, a wrangler secret on the api. The
  provider package is chosen with `npm view` in the agent's PR.
- The stream goes out on the same `/chat` with `UI_MESSAGE_STREAM_HEADERS`, the framing the script
  already writes, so the web transport does not change. How the api builds it is in
  the amendment "the budget lock and the stream". The api now carries the `ai` runtime and a
  provider package; the agent's PR moves the ADR-027 baseline with measured numbers.

This model call does not go through the facade or the transport ladder, and OpenRouter is its only
transport. That is the exception to DR-9. §29.2's invariants still hold: cost comes from the log,
the budget is reserved server side before the call, and the key lives only in the api's secrets.
A transport outage lands on the deterministic fallback, §28.2's degraded mode for a model task that
has deterministic rules. The facade's `pre_model_call` hook (§6.3: context assertion and budget
check) is not used either. Its two checks are the per-call hash check and the per-org reservation
below.

### Tools

`get_workspace`, `get_facts` and `get_preview` read. `request_change`, `answer_question` and, with
reminders, `create_reminder` act. Each act tool is `'user-approval'` in the agent's map. There is no
publish tool. Publishing stays the owner's button on a bound version.

`answer_question` always asks. The plan was to approve it automatically when the value parses as
`FactValue`, but a parse proves the value's shape, not that the owner said it. An automatic yes
would store a model's guess as `owner_stated`, from where it can reach the site, which R8 forbids.

Every act tool's side effect is keyed by its approval id, as `request_change` already is through
`startChange`, so running it twice replays the first run. A steer is the exception until the
amendment "a timed-out bridge call has an unknown outcome" closes it. Tools run inside the agent's
stream, outside any conversation lock, and open their own `withOrg`. Each description says when
to use the tool and when not to. Each output is a compact summary.

### The model's history comes from the event log

A conversation is a session in `events`. Its rows carry `session_id` equal to the conversation id,
`staff_id` equal to the org's CoS staff row, and a `seq` that `apps/api` allocates as the stream's
single writer. The `(session_id, seq)` unique index refuses a second writer. `appendSessionEvent`
in `packages/db` reads the last seq and writes the next one in the same statement. `newUlid()`
from `@workspace/db` is the api's only ULID source, from the same monotonic factory the appenders
use, and `apps/api` takes no `ulid` dependency of its own. The export is built; the agent's PR is
the first to call it, for turn ids.

- `cos.prefix`, once per session per prefix version: the instructions and tool definitions as
  sent, with the version and its SHA-256.
- `cos.context`, in the turn's first transaction: the turn id, prefix hash, context policy version,
  mode, active tools, context text and reserved spend.
- `cos.message`, in the first transaction and at the turn's end: a whole `UIMessage`. That is the
  owner's message, the tail with the owner's answers and approvals applied, or the response.
- `cos.tool_result`, in each tool's `execute` before it returns: the call id, tool and output.
- `cos.step`, in `onStepEnd` after each step: the step's response messages, usage and cost.
- `cos.call`, in `prepareStep` after the check below passes: the step number and the SHA-256 of
  the messages sent.
- `cos.turn`, at the turn's end or when it is abandoned: `CosTurn`. Never model-visible.

Taint follows what an event carries. Owner text is `untrusted_input`. Text another agent wrote,
such as a question's `why` or a build goal restated by the Developer, is `inferred`. So
`cos.context` and `cos.tool_result` carry both labels whenever their text includes both.

`deriveCosMessages(events, policy)` takes events only and returns the messages for a call. For a
turn's first call it takes the last `cos.message` for each id in order of first appearance. It
applies a `cos.tool_result` only to a call that was approved and still waiting to run, as the log
stood when the result was written. That is the one state in which a result reaches the log before
the message that shows it. A call in any other state is never changed, a denied one included, so
a provider that reuses a call id in a later turn cannot rewrite an earlier call. The turn's
`cos.context` text goes in a user-role message, id `context-<turn_id>`, just before the owner's
latest message. It never goes in a system message, because it carries owner and agent text.

The derivation returns the UI messages and, separately, the `cos.step` messages the turn has logged
so far. The agent's code runs the SDK's `convertToModelMessages`, appends the steps and hashes the
result, so the derivation imports only types from `ai`. The policy keeps the last 12 turns, a turn
being an owner message and the replies after it. In turns older than the newest two it drops tool
parts, the call and its output together, since a placeholder output would fail `validateUIMessages`.
In those older turns, a message left with nothing but step boundaries is dropped. The policy is an
api-local type, version `"1"`. Only its version crosses a boundary, in `cos.context`, and a changed
policy takes a new version, because a log written under one version does not derive under another.
The derivation reads no clock and no environment. The derived messages pass `validateUIMessages`
with the agent's tools.

**The check that refuses a mismatch.** `prepareStep` is awaited before every model call
(`dist/index.js:10015`), and a throw there ends the stream without a call. Before each call it reads
the session's events back, derives the expected messages, and compares their hash with the
messages the SDK is about to send. A mismatch throws an `integrity` error: no call is made, the
turn ends with outcome `integrity`, and ops are alerted. As §28.1 says, the conversation is then
frozen: a later turn that finds an `integrity` outcome in its session takes only the fallback, for
good, and the owner starts a new conversation. Nothing unfreezes one. On a match `prepareStep`
appends `cos.call` with the hash. The step's output is logged in `onStepEnd`, which the SDK
awaits before the next step (`dist/index.js:9556`, `:10385`) but whose errors it swallows
(`notify`, `:2769`). A failed step write therefore surfaces as a mismatch at the next
`prepareStep`, never as a silent gap.

This meets §10.6 at every call, not only the first: the model receives code logged by version in
`cos.prefix` and messages derived from events appended before that call.

`conversation_messages` stays the rows assistant-ui reads. The server writes them in the same
transactions as the events, and may still rewrite the tail. They cannot reach the model, because
whatever the api passes, the call is refused unless its messages equal the ones derived from the
log. The agent, the derivation and the tools live in `apps/api/src/cos/`. A Biome override on that
directory bans the `conversationMessages` import from `@workspace/db`, and today also `../chat.ts`
and `../conversations.ts`, which import that table. The rule is that `cos/` imports no module that
reaches the table, directly or through another module. `cos/tools.ts` still reaches it through
`owner.ts`, which imports `chat.ts`, and `org.ts` imports the table itself. So a refactor before
the agent's PR moves what the tools need out of `owner.ts` into `changes.ts`, moves `ownerStaffId`
out of `org.ts` into `staff.ts`, and adds `../owner.ts` and `../org.ts` to the ban. After it,
`cos/` takes shared code only from leaves such as `http.ts`, `changes.ts` and `staff.ts`. A module
that starts importing the table joins the ban in the same PR. The ban also keeps `chat.ts`, which
will import the agent, out of a cycle with `cos/`. That rule is a tripwire. The check is the
boundary.

### A turn

1. A first transaction takes the conversation's lock (key 2), then the org's budget lock (key 3). It
   refuses with 409 `chat.busy` while another turn is open, or when another writer appended to the
   session while it was opening (`SessionBusy` from `closeLapsedTurn`, which is built; the agent's
   PR adds the call and the 409). It validates the request, reserves spend, and appends `cos.prefix`
   when the version is new, `cos.message` for the owner's input, and `cos.context`. It writes the
   owner's row and commits. Every turn routed to the CoS writes `cos.context`, one that falls back
   included, so every such turn holds a token and ends with a `cos.turn`.
2. The agent streams outside any lock. The api buffers chunks until the first content chunk, text,
   reasoning or tool input, or an error. `start` does not count, because `streamText` emits it
   before any provider call (`dist/index.js:9662`) and a provider error arrives later as an error
   chunk. An error before content becomes the fallback below. Afterwards the stream passes through.
3. `onFinish` runs under `ctx.waitUntil`, on the branch that the amendment "the budget lock and
   the stream" tees off. A second transaction appends the response's `cos.message` and `cos.turn`
   and writes the rows. The api forwards the `finish` chunk
   only after that transaction commits. The next request an approval triggers therefore arrives
   after the turn has closed, and `chat.busy` reaches only a second tab. The web shows its message
   there and does not retry.

**One writer per turn, by token.** Every write a turn makes after its first transaction, including
`cos.tool_result`, `cos.step` and `cos.call`, runs in a short transaction that takes the
conversation's lock (key 2) and checks that the session's latest `cos.context` carries its turn
id and has no `cos.turn`. A turn that fails the check has its write refused and its stream
aborted.

**Abandonment.** A turn is open from its `cos.context` to its `cos.turn`. The clock starts at
`cos.context`, which is before the SDK starts its own. A turn is abandoned `totalMs` plus 30 s after
that. The 30 s is the grace `ctx.waitUntil` gets after the response ends or the client disconnects,
which Cloudflare documents as up to 30 seconds (workers/platform/limits, checked 2026-09-27). The
next turn appends `cos.turn` with outcome `abandoned` for it under the lock, which closes it to the
token check, so it cannot write late. A tab closed more than 30 s before its turn would have ended
loses the turn's tail the same way.

**An approved call with no result.** A turn can die after an approved tool ran and before its result
was logged. The dead turn's token is closed by then, so the next CoS turn owns the repair. Its
first transaction abandons the dead turn and appends its own `cos.context`. Then, before the model
call or the fallback, it runs that call's tool again under the approval id, which replays the first
run, and appends the `cos.tool_result` under its own token. The write follows the token rule, and
it is never refused forever, because the turn that makes it is open. History never holds an
approved call without a result.

A message id already stored gets 409 `chat.message_exists`, as now. A results turn whose calls are
already resolved gets 409 `chat.stale`, and the web reloads the stored rows. The script keeps its
own replay of calls it resolved. Every turn in the conversation, the script's included, respects
the open-turn rule.

### Who answers a turn

- An onboarding conversation belongs to the script until its build offer is approved or refused.
- A results turn goes to whoever made the calls. That is the CoS when a `cos.message` in the session
  names the tail message, and the script otherwise, since the script made every `ask_fact`, the
  onboarding offer and every fallback card.
- Every other turn goes to the CoS, in every conversation, the onboarding one included.
- The CoS falls back when no key is configured, when the org's budget cannot cover the
  reservation, or when the provider fails before the first content chunk. For a typed message the
  fallback is the script's step: the change card in Act mode and a fixed line in Ask mode. That
  turn writes no `cos.message`, so the model learns its effect from the next context message.
- For a results turn the fallback resolves each result in order without the model. A denial becomes
  `output-denied`. An approval runs the tool's own function under its approval id, whichever of
  `request_change`, `answer_question` or `create_reminder` it is, and its output is logged as
  `cos.tool_result`. The resolved message is logged as `cos.message`, with no model text.
- `cos.turn` records every fallback with its reason class: `provider`, `budgetary` or `resource`.
  A provider failure after content ends the stream with an error chunk whose text a sanitising
  `onError` wrote, and the outcome is `error`.

### Caps and cost

The cap is $1 per org per UTC day of CoS spend. The first transaction holds the org's budget lock
while it sums the day's spend: settled cost for closed turns, the reservation for open ones, and the
full reservation for abandoned ones, whose last step's usage is lost. It then adds this turn's
reservation, or falls back if that would pass $1. Concurrent turns in five conversations therefore
cannot overshoot. The reservation is the worst case of six steps at 30,000 input tokens and
`maxOutputTokens` at the model's price in `openrouter.models.json` in `packages/facade`. That table
prices every call at its routing cap, 2.1 times OpenRouter's list price, which is the most any
provider it routes to can bill. On 2026-09-27 that is $0.0735 per million input tokens and $0.609
per million output for `deepseek/deepseek-v4.1-flash`, so the reservation is
6 × (30,000 × $0.0735 + 1,000 × $0.609) / 1,000,000, about $0.017. Both token figures are guesses
the agent's PR replaces with measured p99s, and the table is regenerated whenever the model changes.

Step cost is priced from usage at the same table the Developer's metering uses, so both reconcile
against one OpenRouter bill. Priced at the cap, the logged sum overstates the bill by up to the
factor until each call's actual cost is logged. Until then, the check before the CoS ships is that
the bill is at or under the logged sum, with the gap reported, abandoned turns reported twice, at
logged spend and at reservation, and the bill between the two. The cap is a ceiling,
not a forecast: $31 per org in a 31-day month, $31,000 at 1,000 orgs if every org spends it. The
agent's PR measures typical cost per turn and first-chunk p95 over 20 staging turns.

### Contract changes, in one contracts PR before the agent

- `ChatRequest.turn` becomes two kinds. `message` is unchanged. `results` carries `message_id` and
  at least one result: `{kind: "answer", tool_call_id, output: AskFactOutput}` or
  `{kind: "approval", approval_id, approved, reason?}`. The old `answer` and `approval` kinds are
  removed in the same change; no production tenant exists, and a stale staging tab gets a 400. The
  server refuses, with 409 `chat.stale`, a set that is not exactly the pending calls of the tail
  message's last step. The script takes a `results` turn of exactly one result.
- `reason` is `Text(ANSWER_TEXT_MAX)`, owner text, tainted and model-visible. The web copies what
  the SDK holds, so the server's history matches the screen.
- `tool_call_id` becomes `^[\x21-\x7E]{1,128}$`, printable ASCII with no spaces. The server looks
  the id up among its own pending calls, so the pattern only limits size and characters.
  `approval_id` and message ids keep their rule, because the SDK and the api make them.
- New `cos.ts`: an input and an output schema per tool, in one `COS_TOOLS` record. `AskFactInput`
  is not a model tool and stays as it is.
- `CosTurn`, the `cos.turn` payload, is a union on `outcome`. `answered`, `fallback`, `error` and
  `integrity` carry the model, usage, cost, tools called, steps and first-chunk milliseconds, and
  `fallback` adds its reason class. `abandoned` carries the logged spend and the reservation.
- The payloads of the six model-facing `cos.*` events, which the eval replay reads.
- The web builds its message type from these schemas, and an api type test checks
  `InferAgentUIMessage<typeof cosAgent>` against the same schemas.

### Proofs each PR owes

The contracts PR: round trip, fuzz and drift green; every `COS_TOOLS` input converts with
`z.toJSONSchema` to `type: "object"` at the root with no root `anyOf`, `oneOf` or `allOf`;
`tool_call_id` accepts `functions.ask_fact:0` and `call_abc123` and refuses a space and 129
characters; `results` refuses an empty list.

The agent's PR, each red once by mutation:

- Tenancy lives only in `runtimeContext`: with `MockLanguageModelV4`, the recorded request carries
  none of the turn's org, user, session or conversation ids, and another org's conversation gets
  404 before any model call, as a tenancy case.
- Derivation is deterministic: the same events give the same hash twice, and a clock read in the
  derivation turns it red.
- A dropped `cos.step` write makes the next `prepareStep` refuse with no model call.
- The import ban fails `pnpm lint` on a deliberate `conversationMessages` import in `cos/`. After
  the refactor before the agent's PR, it also fails on an import of any module that reaches that
  table.
- `answer_question` with a value that parses as `FactValue` still ends in `approval-requested`, and
  every act tool does.
- A second turn while one is open gets 409 `chat.busy`; after `totalMs` plus 30 s the next turn
  appends `abandoned` and runs, and the old turn's next write is refused.
- A stored message id gets 409 `chat.message_exists`.
- Five concurrent turns in five conversations of one org never reserve past $1.
- With a reservation's transaction held open on an org, inserts into `events`, `assignments` and
  `conversation_messages` for that org commit without waiting. The proof fails if the budget lock
  is `FOR UPDATE` on `orgs`.
- A client that disconnects mid-turn does not stop the model run: the turn still ends with
  `answered`, and its `cos.turn` is written before `totalMs` passes.
- A turn killed after an approved `request_change` ran leaves the next turn to append exactly one
  `cos.tool_result` under its own token, and the orchestrator holds one build for that approval id.
- A conversation with an `integrity` outcome takes only the fallback on every later turn.
- Taint labels: a turn whose context carries owner text and a question's `why` labels
  `cos.context` and the `get_workspace` result `untrusted_input` and `inferred`, and an owner
  message alone labels its `cos.message` `untrusted_input` only.
- With no key, one results turn approving one `request_change` and one `answer_question` and
  denying a second `request_change` makes no model call, runs each approved tool once under its
  approval id in order, logs two `cos.tool_result` rows and one `cos.message`, and stores the
  denial as `output-denied`. The PR that ships reminders adds a denied `create_reminder`.
- With the second transaction held open, the client receives no `finish` chunk until it commits,
  and a follow-up request sent on `finish` never gets `chat.busy`.
- A provider error before content gives the fallback, not a 5xx, and one after content gives an
  error chunk.

### Before the agent's PR merges

- The bridge deadline and the database limits in the amendment "a timed-out bridge call has an
  unknown outcome", which replaces the two bullets that stood here.
- A steer replays by key, as that amendment says.
- A recorded staging turn from the chosen model and provider, committed as an api test fixture,
  shows that its tool-call ids pass the new pattern.
- The contracts PR and `appendSessionEvent` in `packages/db` are merged.

## What was rejected

- **Sending `conversation_messages` to the model with a hash check.** The check needs a trusted
  record to compare against, which is the log. Once the log exists, derive from it.
- **Append-only message rows.** ai 7 continues the last assistant message, so a second row with the
  same id shows twice. The script's design already rejected it for that reason.
- **Logging only at the turn's end.** Steps two to six would receive earlier steps' output before
  it was logged, which is exactly what §10.6 forbids.
- **One tool call per step through a provider option.** Not every provider honours it, and a model
  switched by env would lose it without a sign.
- **Mapping provider tool-call ids to ids we make.** Replay would need the map in the log, while
  the server's lookup already makes the id's shape irrelevant.
- **The CoS as a flue `lite` runtime now.** It has no memory, documents or skills to read yet, and
  it would put flue in the api. §6.3 still describes where it ends up.
- **A stored "turn in progress" flag.** A Worker that dies mid-turn leaves it set. An open turn
  derived from the log and the clock cannot stick, and the token stops a late writer.
- **Checking the cap against finished turns only.** Concurrent and killed turns would never count.
- **Running the model inside the conversation lock.** That is a reversal trigger of the ruling that
  accepted the lock.

## Consequences

- The onboarding script and its determinism test stay as they are. The script is also the CoS's
  fallback.
- A reload mid-turn shows the owner's message and no reply until the turn ends. There are no
  resumable streams until realtime (C8) lands.
- The web still reaches the api over public HTTP. The first-chunk p95 shows whether that costs
  anything.
- There is no fact-editing tool. A changed fact stated in chat gets pointed at the profile page.
- Each model call costs one extra read of the session's events and one small write per step.
- Model-visible events sit in store 6's 90-day hot window.

## Change if

- The first PR of the delivery plan's "CoS runtime (lite)" row, or the first CoS tool or
  instruction that reads memory, documents or skills. The CoS moves behind the facade as a `lite`
  runtime, and the exception to DR-9 ends. Whichever comes first ends it.
- Fallbacks with reason `provider` pass 1% of a week's turns. Add a second transport.
- An owner loses a turn to a reload, or C8 lands. Build resumable streams.
- First-chunk p95 through the web is more than 100 ms above the api's own. Move the web to a
  binding.
- A real owner hits the $1 cap or the 20 builds a day. Reprice both.
- Archiving or pruning `events` reaches a live conversation's session. The derivation reads the
  archive, or the session gets a compaction event first.
- One eval failure or one owner report in which the CoS contradicts a fallback turn it never saw.
  Log fallback turns as model-visible.
- The owner decides the `answer_question` card costs more than it protects, after the CoS evals
  and 200 live turns show no fabricated value. Reconsider automatic approval with that record.
- The first frozen conversation on a real org. Build a way to unfreeze one.
- Any caller other than the owner's own turn takes the conversation lock, a model call runs inside
  it, the approval turn's p95 passes 5 s, or a Hyperdrive connection-count alarm fires. Build the
  two-transaction approval.

## Amendment, 2026-09-27: a timed-out bridge call has an unknown outcome

The review of the timeout PR found that the two bullets that stood under "Before the agent's PR
merges" read a timeout as a refusal and gave each bridge call its own clock. A 5 s statement limit
also cut short the wait on the conversation's row lock, which the approval holds while
`startChange` reads and calls the orchestrator. This section replaces those bullets.

**What an answer from the orchestrator means.** Only a 4xx with an envelope that parses is a
refusal. A timeout, a 5xx and an off-contract answer all mean the outcome is unknown: the call may
have committed. On an unknown outcome the api answers 503 `transient` and makes no further call for
that request. It never cancels or reports a refusal because of one. This holds for every
`bridge()` call: the answer, cancel and preview routes and the approval decision included.

**A retry re-drives the steps left.** `startChange` answers a retry from its key lookup, which
finds the build the key made. That lookup now decides what is left to do, from the builds' states,
with no stored step:

- No build under the key: route and run as a first attempt.
- The key's build is `cancelled`: answer 409, class `validation`, code `change.cancelled`, with
  the build's `assignment_id` in `detail`. The chat keeps a `validation` refusal as the card's
  answer, so the owner asks again with a new key. The code is new, but `ErrorEnvelope.code` is a
  pattern, not a list, so the contracts do not change. The web adds its copy.
- The key's build is `queued` and routing the org's other builds would still replace one: end that
  one under the key, as a first attempt would.
- Anything else: answer the build's summary.

On the replace path, a first attempt or a re-drive runs these steps:

- The create's outcome is unknown: answer 503 and leave the old review alone.
- Ending the old review has an unknown outcome: answer 503 and leave the new build alone.
- Ending the old review is refused: cancel the new build and answer the refusal. If the cancel's
  outcome is unknown, answer 503, and the retry finds the new build still queued and tries again.

A new build that the owner never retries stays queued behind the old review until the review
expires, 72 hours at most. That is accepted. The fix is one keyed call in the orchestrator that
ends the old review and creates the new build in one transaction.

**One deadline per change.** `startChange` creates one `AbortSignal.timeout(10_000)` on entry. It
races its own `withOrg` reads against that signal and passes the signal to every bridge call it
makes, so everything it awaits ends within 10 s. A read the race gives up on runs to its own
statement limit on its own connection. The one write among them, `ownerStaffId`, finds the row
it would create, so letting it finish after the race is harmless. `bridge()` makes its own 10 s
signal when its caller passes none. Ten seconds is 7.5 times one measured `POST /changes` of
1,330 ms. The agent's PR records 20 staging approvals, at least 5 of them replacing an open
review, and sets the deadline to three times the p95 of the replacing ones.

**Only a turn takes the turn's lock.** A row lock on the conversation also collides with renaming
and archiving it, since an `UPDATE` takes the row, and with inserting its messages, since the
foreign key takes a share lock on it. So a turn no longer locks the conversation's row. It reads
the row under RLS, and a missing row answers 404 as now. Then it takes
`pg_try_advisory_xact_lock(2, hashtext(conversation_id::text))`. Postgres keeps the two-key form
apart from the one-key form, so it never meets the site lock in `apps/orchestrator/src/publish.ts`,
and the first key leaves room for other two-key locks. When the call returns false, the api
answers 409 `chat.busy`, the answer this ADR already gives a concurrent turn. Only turns take this
lock, so a false means a turn is open or closing. Every place this ADR says a transaction takes
the conversation's row lock, it now means this lock. The token writes and the abandonment take it
with `pg_advisory_xact_lock`, which waits. The statement limit bounds that wait, and their holders
are short. No `lock_timeout` is set. Two conversations whose ids hash alike answer `chat.busy`
only when their turns overlap.

**The database limits.** Every transaction `withOrg` opens sets `statement_timeout` to 5 s and
`idle_in_transaction_session_timeout` to 15 s, transaction-locally, in the select that already
sets the org context, so they cost no round trip.

The idle limit is the deadline plus 5 s. A turn holding the lock sits idle only while it awaits
`startChange`, and the deadline ends that wait at 10 s, reads included. The idle limit becomes the
measured deadline plus 5 s. The statement limit becomes ten times the slowest statement's p99 in
Neon's `pg_stat_statements` over a week of staging.

The org resolvers (`resolveOrg`, `resolveOrgBySlug`, `listOrgIds`) set neither limit. Each sends
`set local role` and then one select, with nothing awaited between the two but the database, so
there is no idle gap to limit. A setting also cannot govern the statement that sets it, so
carrying the limits would cost a third round trip on every request. `resolveOrg` and
`resolveOrgBySlug` look up one unique key, and `listOrgIds` reads the orgs once an hour.

The tenancy kit is shared, so the limits reach the orchestrator and the router too. The PR lists
every `withOrg` in those workers that awaits something other than the database inside the
transaction, with its bound. One is known. `deleteRevisionFiles` lists and deletes R2 objects
inside the sweep's transaction, so a stalled R2 call now ends that transaction at 15 s. The sweep
step retries, and every part of the sweep is idempotent. The fix moves the R2 work out of the
transaction: the guards read in one transaction, the event naming the keys is written in its own,
and the list and delete run with no transaction open. It is built on the first sweep that the
idle limit kills, by the trigger below.

**A steer replays by key.** "Tools" says every act tool's side effect replays under its approval
id. A steer does not. The orchestrator records nothing a retry could find, so a steer that timed
out after it was delivered is delivered twice. Before the agent's PR merges, the orchestrator
stores each steer under its idempotency key, and a replay returns the first result without
delivering the message again.

Rejected:

- **A turn waiting on the lock**, through a `lock_timeout` or a statement limit above the
  deadline. Each waiting turn holds a second connection for up to the whole deadline, and learns
  nothing a 409 would not tell it.
- **`for update nowait` on the conversation's row.** Renaming, archiving and writing messages take
  the same row, so a turn would get `chat.busy` with no turn open, and the web does not retry it.
- **A deadline per bridge call.** The replace path makes three calls, so the idle limit would need
  3 × 10 s, plus the reads, plus 5 s: over 40 s. A hung orchestrator would hold the lock for 30 s
  instead of 10.
- **Cancelling on an unknown outcome.** The call may have committed, and the cancel then throws
  away the owner's change.
- **A table of replace steps per key.** The builds' states already say which steps are done.

Change if:

- The first `orchestrator.timeout` on a replace, or an owner report of a build left queued. Build
  the one-call replace.
- A 25P03 in Neon's Postgres log, which only the idle limit writes. Find the gap, then fix the
  code that made it or move the limit. A `CONNECTION_CLOSED` in a Worker's log is a hint to look,
  not the trigger, since an ordinary dropped connection gives the same code. That code was
  measured on a direct connection; what a Worker sees through Hyperdrive is to be confirmed on
  staging.
- A 57014 on a statement that was not waiting on a lock, or on one waiting on the budget lock
  (key 3), since that means a reservation transaction ran past 5 s. Read the plan in
  `pg_stat_statements`, then fix the query or move the limit with that measurement.

## Amendment, 2026-09-27: the budget lock and the stream

**The budget lock.** The decision said the first transaction takes "the org's row lock". As
`SELECT ... FOR UPDATE` on `orgs`, that lock conflicts with the `FOR KEY SHARE` lock every insert
with a foreign key to `orgs` takes. Events, conversation messages and assignments all have one,
the orchestrator's event stream included. A turn reserving spend would wait on each of those
writers, and they on it, the same fault the first amendment fixed for conversations.

The first transaction takes `pg_advisory_xact_lock(3, hashtext(org_id::text))` instead, always
after the conversation's lock (key 2) and never before it, so two turns cannot take the pair in
opposite orders. It waits rather than tries. Its holders are the short reservation transactions,
and the 5 s statement limit bounds the wait. Key 3 is free. The site lock in
`apps/orchestrator/src/publish.ts`, the seed lock and the migration lock all use the one-key form,
which Postgres keeps apart from the two-key form, and nothing else takes key 3. Two orgs whose ids
hash alike wait on each other's reservation, which lasts one short transaction.

When the wait passes the statement limit, Postgres cancels it with 57014. The first transaction
rolls back, nothing is stored, and the api's catch-all answers 503 `transient`, which the owner can
send again. It is not `chat.busy`: the conversation has no open turn.

Rejected: `FOR NO KEY UPDATE` on the org's row. It does not conflict with a foreign-key insert.
It does conflict with every `UPDATE` of the row and every `FOR SHARE`, so the budget would queue
behind any write to the org, and whoever writes to `orgs` next would change who waits on it.

**The stream.** `createAgentUIStream` gives the UI message chunks with no response around them.
The api pipes them through its own transform, which buffers until the first content chunk and
holds `finish` until the second transaction commits. It hands the result to
`createUIMessageStreamResponse` with a `consumeSseStream` that passes its branch to
`ctx.waitUntil` and reads it to the end. That function tees the SSE stream there
(`dist/index.js:6561` in 7.0.83), and a tee cancels its source only when both branches cancel. So a
closed tab cancels the response's branch while the waitUntil branch keeps reading, and the model
run goes on to its `onFinish`. The agent's `abortSignal` is never the request's signal. The 30 s
grace after a disconnect still applies, as "Abandonment" says.

A run that does abort, from the turn's own token check or its `timeout`, ends in the stream's
`onEnd` with `isAborted` true. That `onEnd` closes the turn at once: under the turn's own token it
appends `cos.turn` with outcome `abandoned`, the spend its `cos.step` rows logged and the
reservation, and it writes no response message. The next turn does not wait `totalMs` plus 30 s
for it. Only a Worker killed before `onEnd` runs leaves the turn to that timer.

Rejected:

- **`createAgentUIStreamResponse`.** It goes from the agent to a `Response` in one call, so the
  api has no point at which to buffer until the first content, answer an early provider error with
  the fallback, or hold `finish` until the commit.
- **Building the SSE pipeline by hand** from `JsonToSseTransformStream` and `TextEncoderStream`.
  It drops the `consumeSseStream` tee, so a closed tab aborts the model run.

**Five tools at first.** The agent's PR ships `get_workspace`, `get_facts`, `get_preview`,
`request_change` and `answer_question`. `create_reminder` arrives with reminders, as "Tools" says,
so the fallback proof denies a second `request_change` until then.

**The idle trigger.** The server writes 25P03 to its own log when the idle limit kills a
session, and that is the trigger in the first amendment. The driver sees only a closed
connection.
