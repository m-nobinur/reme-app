# ADR-034: The Chief of Staff is an AI SDK agent in the api, and its history comes from the event log

Status: accepted, 2026-09-27. Applies to `apps/api`, the chat in `apps/web`, `packages/contracts`
and `packages/db`. Changes no DR. It makes one scoped exception to §6.3 and DR-9 for the Chief of
Staff (CoS), which ends on the first trigger under "Change if".

## Context

The owner's chat already runs on `POST /chat` in `apps/api`, with no model. A script asks for each
missing fact with an `ask_fact` tool call, offers the first build as a `request_change` approval,
and afterwards turns a message typed in Act mode into another change card. It writes the AI SDK's
SSE frames by hand and imports only types from `ai`. History lives in `conversation_messages`, and
an answer or an approval rewrites the tail assistant row by compare-and-swap, because ai 7
continues the last assistant message rather than starting a new one.

A model can take over from the script, but four things in the shipped code stand in the way:

1. §10.6 and R7 require the context sent to a model to be a pure function of the append-only log.
   `conversation_messages` is mutable, so it cannot be that log.
2. `ChatRequest` carries one answer or one approval per turn. The AI SDK sends once every pending
   call in the last step is resolved, and a model can make several calls in one step. The SDK's
   approval response also carries an optional `reason` that the contract drops. And `AskFactInput`
   is a union at its root, which provider tool APIs refuse as tool parameters.
3. `tool_call_id` follows the message-id rule `^[A-Za-z0-9_-]{1,64}$`, which refuses ids some
   providers emit, such as `functions.ask_fact:0`.
4. `bridge()` in `apps/api/src/owner.ts` has no timeout, and the script's approval holds the
   conversation's row lock across that call.

## Decision

### The agent

`apps/api/src/cos/agent.ts` is a `ToolLoopAgent` from `ai` 7.0.83, pinned exactly. Every name
below was checked in the installed `ai/dist/index.d.ts`.

- `callOptionsSchema` takes the mode (`ask` or `act`), the per-turn context text, and the session's
  org, user, session and conversation ids. `prepareCall` sets `activeTools`, places the context
  message, and moves the ids into `runtimeContext`. It reads nothing itself. The ids never enter
  instructions, messages or a tool input, so the model has no way to name another tenant.
- Ask mode gets the read tools only. Act gets all of them.
- `stopWhen: isStepCount(6)` and a per-step `maxOutputTokens`, which the agent's PR sets from
  measured output and records.
- The model comes from `COS_MODEL`, default `deepseek/deepseek-v4.1-flash`. That id is in
  `packages/facade/src/models/openrouter.ids.json` today, and a unit test keeps it there. The agent
  reaches it through OpenRouter with `OPENROUTER_API_KEY`, a wrangler secret on the api. The
  provider package is chosen with `npm view` in the agent's PR.
- The stream goes out on the same `/chat` with `UI_MESSAGE_STREAM_HEADERS`, the framing the script
  already writes, so the web transport does not change. The api reads the first chunk from
  `createAgentUIStream` before it answers, so a failure before that chunk can still become the
  fallback below. The api now carries the `ai` runtime and a provider package. The agent's PR moves
  the ADR-027 baseline with measured numbers.

This model call does not go through the facade or the transport ladder, and OpenRouter is its only
transport. That is the exception to DR-9. §29.2's invariants still hold: cost comes from the log,
the budget check runs server side before the call, and the key lives only in the api's secrets. A
transport outage lands on the deterministic fallback, which is §28.2's degraded mode for a model
task that has deterministic rules.

### Tools

`get_workspace`, `get_facts` and `get_preview` read. `request_change`, `answer_question` and, with
reminders, `create_reminder` act, and each carries `toolApproval: 'user-approval'`. There is no
publish tool. Publishing stays the owner's button on a bound version.

`answer_question` always asks. The plan was to approve it automatically when the value parses
as `FactValue`, but a parse proves the value's shape, not that the owner said it. An automatic yes
would store a model's guess as `owner_stated`, from where it can reach the site, which R8 forbids.
The owner's yes on a card that shows the value is what makes it `owner_stated`.

`request_change` runs the same `startChange` the script runs, keyed by the approval id, so a retry
replays the build it made. It runs inside the agent's stream, outside any conversation lock.

Each description says when to use the tool and when not to. Each output is a compact summary. Tool
output and a question's `why` are data, and the owner's text is tainted.

### The model's history comes from the event log

A conversation is a session in `events`. Its rows carry `session_id` equal to the conversation id,
`staff_id` equal to the org's CoS staff row, and a `seq` that `apps/api` allocates as the stream's
single writer. The `(session_id, seq)` unique index refuses a second writer. `appendEvent` moves into
`packages/db` first, which gives the api a ULID source.

| Event | Written | Holds |
| --- | --- | --- |
| `cos.prefix` | Once per session per prefix version | The instructions and tool definitions as sent, with the version and its SHA-256 |
| `cos.context` | Before each model call | The prefix hash, the context policy version, the mode, the active tools, the context message text, and the SHA-256 of the messages passed to the agent |
| `cos.message` | Whenever a turn creates or changes a message | The whole `UIMessage`: the owner's message; the tail assistant message with the owner's answers and approvals applied; the response at the turn's end. Owner text is tainted `untrusted_input` |
| `cos.tool_result` | Inside each tool's `execute`, before it returns | The call id, the tool and its output |
| `cos.turn` | At the turn's end | Metering. Never model-visible |

`deriveCosMessages(events, policy)` takes the last `cos.message` for each id, in order of first
appearance, and puts the latest `cos.context` text just before the owner's latest message. The SDK's
`convertToModelMessages` and a `prepareStep` that runs `pruneMessages`, keeping the last 12 turns and
trimming tool outputs older than two turns, do the rest, under the policy version `cos.context` records.
It reads no clock and no environment. The derived messages pass `validateUIMessages` with the
agent's tools. A failure there is an `integrity` refusal, logged, and never falls back.

This meets §10.6. The model receives code logged by version in `cos.prefix`, events appended before
the call (`cos.context`, `cos.message`) or before the next step (`cos.tool_result`), and its own
output from earlier steps of the same turn. That last part is logged by the turn's closing
`cos.message`. A turn that dies first never writes it, so the next turn's history leaves it out,
and nothing unlogged reaches a later call. The recorded hash lets the CoS eval replay check each
call against the log, as the Developer's recorded sessions do.

`conversation_messages` stays the rows assistant-ui reads. The server writes them in the same
transactions as the events, and it may still rewrite the tail. The model path never reads them. The
agent, the derivation and the tools live in `apps/api/src/cos/`. A Biome override on that directory
restricts the `conversationMessages` import from `@workspace/db`, so CI refuses the read. The rows
are written from `apps/api/src/chat.ts`.

### A turn

1. A first transaction takes the conversation's row lock. It refuses with 409 `chat.busy` while
   another turn is open, validates the request, and appends `cos.prefix` when the version is new,
   `cos.message` for the owner's input, and `cos.context`. It writes the owner's row and commits.
2. The agent streams outside any lock. Tools open their own `withOrg`.
3. `onFinish` runs under `ctx.waitUntil` with `consumeStream`, so a closed tab still saves the turn.
   A second transaction takes the lock again, appends the response's `cos.message` and `cos.turn`,
   and writes the rows.

A turn is open from its `cos.context` to its `cos.turn`. One older than the agent's
`timeout.totalMs` is abandoned: the next turn appends a `cos.turn` with outcome `abandoned` for it
and goes on. Elapsed time decides it, so no stored flag can get stuck. Script turns in the same
conversation respect it too.

A message id that is already stored still gets 409. A results turn whose calls are already resolved
gets 409 `chat.stale`, and the web reloads the stored rows. The side effects are keyed by the
approval id, so a retry never starts a second build. The script keeps its own replay of calls it
resolved.

### Who answers a turn

- An onboarding conversation belongs to the script until its build offer is approved or refused.
- A results turn goes to whoever made the calls. That is the CoS when a `cos.message` in the session
  names the tail message, and the script otherwise, since the script made every `ask_fact`, the onboarding offer and
  every fallback card.
- Every other turn goes to the CoS, in every conversation, the onboarding one included.
- The CoS falls back to the script's step when no key is configured, when the org's daily cap is
  spent, or when the provider fails or sends nothing within `timeout.firstChunkMs`, before the
  first chunk reaches the owner. For a typed message the script's step is the change card in Act
  mode and a fixed line in Ask mode. For a results turn the fallback resolves the calls as the
  script does, logs the resolved message and adds no model text.
- A fallback for a typed message writes no `cos.message`, so the model never sees it. The model
  learns its effect from the next turn's context message.
- `cos.turn` records every fallback with its reason class: `provider`, `budgetary` or `resource`.
  A provider failure after the first chunk ends the stream with an error chunk whose text a
  sanitising `onError` wrote, and `cos.turn` says `error`.

### Caps and cost

The cap is $1 per org per UTC day of CoS spend, summed from `cos.turn` in the first transaction.
Cost is priced from token usage at the rates the Developer's metering uses, so both reconcile
against one OpenRouter bill. The sum must come within 5% of that bill before the CoS ships. The cap is a
ceiling, not a forecast. At most $30 per org per month, and $30,000 a month at 1,000 orgs if every
org spends it. The agent's PR measures typical cost per turn and first-chunk p95 over 20 staging
turns.

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
- New `cos.ts`: an input and an output schema per tool, in one `COS_TOOLS` record. A test converts
  every input with `z.toJSONSchema` and requires `type: "object"` at the root and no root `anyOf`,
  `oneOf` or `allOf`. `AskFactInput` is not a model tool and stays as it is.
- `CosTurn`, the `cos.turn` payload, is a union on `outcome`. `answered` carries the model, usage,
  cost, tools called, steps and first-chunk milliseconds. `fallback` carries the reason class and
  whatever the model spent before failing. `error` carries the same meters. `abandoned` carries
  nothing.
- The payloads of the four model-visible `cos.*` events, which the eval replay reads.
- The web builds its message type from these schemas, and an api type test checks
  `InferAgentUIMessage<typeof cosAgent>` against the same schemas.

### Before the agent's PR merges

- Every `bridge()` call gets `AbortSignal.timeout(10_000)`. A timeout answers 503 `transient`, which
  the chat does not store, so the card's retry replays under the approval id. Ten seconds is about
  seven times the one measured `POST /changes` (1,330 ms). It only has to stop an indefinite hold,
  since an approval p95 over 5 s already reverses the lock design.
- A recorded staging turn from the chosen model and provider, committed as an api test fixture,
  shows that its tool-call ids pass the new pattern.
- The contracts PR above, and `appendEvent` in `packages/db`, are merged.

## What was rejected

- **Sending `conversation_messages` to the model with a hash check.** The check needs a trusted
  record to compare against, which is the log. Once the log exists, derive from it.
- **Append-only message rows.** ai 7 continues the last assistant message, so a second row with the
  same id shows twice. The script's design already rejected it for that reason.
- **Logging model messages instead of UI messages.** The agent's stream takes UI messages, and the
  pinned SDK's conversion is a pure function, so the log holds what the agent is given.
- **One tool call per step through a provider option.** Not every provider honours it, and a model
  switched by env would lose it without a sign.
- **Mapping provider tool-call ids to ids we make.** Replay would need the map in the log, while
  the server's lookup already makes the id's shape irrelevant.
- **The CoS as a flue `lite` runtime now.** It has no memory or skills to use yet, and it would put
  flue in the api. §6.3 still describes where it ends up.
- **A stored "turn in progress" flag.** A Worker that dies mid-turn leaves it set. A time-derived
  open turn cannot stick.
- **Running the model inside the conversation lock.** That is a reversal trigger of the ruling
  that accepted the lock.

## Consequences

- The onboarding script and its determinism test stay as they are. The script is also the CoS's
  fallback.
- A reload mid-turn shows the owner's message and no reply until the turn ends. There are no
  resumable streams until realtime (C8) lands.
- The web still reaches the api over public HTTP. The first-chunk p95 shows whether that costs
  anything.
- There is no fact-editing tool. A changed fact stated in chat gets pointed at the profile page.
- Model-visible events sit in store 6's 90-day hot window.

## Change if

- The CoS needs memory or skills, or delegation work starts. It moves behind the facade as a `lite`
  runtime, and the exception to DR-9 ends.
- Fallbacks with reason `provider` exceed 1% of turns in a week. Add a second transport.
- An owner loses a turn to a reload, or C8 lands. Build resumable streams.
- The first-chunk p95 shows the public hop costs time. Move the web to a binding.
- A real owner hits the $1 cap or the 20 builds a day. Reprice both.
- Archiving or pruning `events` reaches a live conversation's session. The derivation reads the
  archive, or the session gets a compaction event first.
- An eval or an owner shows the CoS contradicting a fallback turn it never saw. Log fallback turns
  as model-visible.
- Evals and live runs show no fabricated `answer_question` values over a quarter, and owners report
  the card as friction. Reconsider automatic approval with that evidence.
- Any caller other than the owner's own turn takes the conversation lock, or the approval turn's
  p95 passes 5 s. Build the two-transaction approval.
