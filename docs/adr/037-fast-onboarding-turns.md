# ADR-037: Code answers card turns, a gate sorts typed ones, the model streams

Status: accepted, 2026-10-01. Applies to `apps/api`, `apps/web`, `packages/ui`,
`packages/contracts`, `packages/facade`, `apps/orchestrator` and `packages/starter-site`. Amends
ADR-036 on who answers an onboarding turn and on the model, and ADR-034 on the Chief of Staff's
model and the daily cap.

## Context

Under ADR-036 every onboarding turn waited on one planner call, card clicks included. Measured
locally on 2026-10-01: 8.5 s a turn, up to 15 s on a slow provider, and the reply arrived in one
piece. The chat pinned the owner's message to the top on send and dropped the reserved space when
the reply landed, so the view jumped back to the previous reply. The flow had about 20 stops.

## Decision

1. **Card answers never call a model.** The answer is structured, so code states the facts and
   writes the next step from written variants in the owner's voice, with the business, assistant,
   owner, template and palette names filled in.
2. **A Jev gate sorts typed replies.** `typesafe/jev-1.13` on OpenRouter's decisions API answers
   typed yes/no and choice questions with a confidence, in about 0.4 s for about $0.00002, and
   writes no text. When a card waits, it asks whether the reply answers it, defers it or does
   something else, and which option it names. Both confidences must clear their thresholds for
   code to answer; anything else, an error, or more than 1 s goes to the planner.
3. **The planner streams.** It answers only typed messages that need understanding. Its JSON puts
   `say` last, so the facts and the next move are checked before the owner reads a word; the
   message then streams a sentence at a time, each sentence checked before it is shown, so no
   word is shown and then taken back. A retry must begin with what was already shown. The turn
   is written once the whole plan checks; a build's message waits for the build's outcome.
4. **Business-specific copy is prepared in the background.** Once the business is known, one
   call writes the photo question and short phrases for the transitions. A step that needs it
   and finds it missing uses the general variant.
5. **A shorter flow.** Contact details are one card, the assistant's name, pronouns and tone are
   another (`ask_details`). Slogan and "how a job runs" are no longer asked; the builder drafts
   them. Industry is inferred, with a card only when it is still unknown. Services, service area,
   customers and what the business needs to quote a job stay.
6. **Models.** Onboarding planner `google/gemini-3.8-flash` at low reasoning for turns the owner
   waits on and medium for background calls (it refuses reasoning off). Chief of Staff
   `openai/gpt-6.1-sol`. Builder `anthropic/claude-sonnet-5.5`.
7. **Cache hits.** Every prompt runs stable to volatile: rules and tools, then the business, then
   the conversation, then the turn. Gemini and GPT cache matching prefixes from 1,024 tokens; the
   Chief of Staff sends a `prompt_cache_key` so an org stays on one provider. The builder sends
   Anthropic `cache_control` breakpoints through pi-ai; reads cost 0.1x, and a build's calls fall
   inside the 5 minute TTL.
8. **Caps.** The daily cap per org (Chief of Staff and planner together) goes from $1 to $100,
   so the owner and their team can test without hitting it; the model cap per build goes from $1
   to $20. Both are the owner's decision for the new models' prices.
9. **Builder effort.** The Developer asks for thinking at `high`, Sonnet 5.5's own default. pi-ai
   sends effort `none` when no level is named, so the default has to be named.
10. **Chief of Staff length.** Its instructions ask for one to three short sentences in plain
   prose. GPT-6.1 Sol takes no `verbosity` setting on OpenRouter, and its 3,100-token output
   limit stays because a change request's tool call carries up to 4,000 characters.

## Consequences

- Most onboarding steps show in under half a second (17 to 21 ms of server time measured
  locally). A typed reply that needs the model shows its first words at p50 3.2 s and p95 7.0 s
  (tier-2 eval, 15 owners, 2026-10-01); the wait is the model's reasoning, which Gemini 3.8
  Flash cannot turn off.
- The same eval: 15 of 15 owners set up, no fallbacks, $0.0068 an onboarding, 81% of planner
  input read from cache.
- Jev is an alpha endpoint. Its failure costs speed, not correctness: the planner answers.
- The model bill per onboarding and per build rises with the new models; the caps bound it.
- Welcome and panel copy name the assistant the owner chose, or speak as "your business
  assistant" before one is chosen.

## Change if

- Jev sends more than one turn in twenty to the wrong path on staging over a week.
- A model turn's first words take longer than 3 s at p95, or a build's cached share of input
  falls under half.
