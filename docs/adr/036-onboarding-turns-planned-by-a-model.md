# ADR-036: A model plans each onboarding turn, and code checks the plan

Status: accepted, 2026-10-01. Applies to `apps/api`, `packages/contracts`, the chat in
`apps/web`, `packages/ui`, `packages/starter-site` and `apps/orchestrator`. Amends ADR-033 on
pricing and ADR-034 on who answers an onboarding turn.

## Context

Onboarding was a script: one `ask_fact` card per missing fact, then a build offer. It asked for an
hourly price, which these businesses do not have, because they quote each job. Owners answer in
their own words, several facts at once, with corrections and side questions, and a keyword table
or a fixed order misreads them. The site's quote form was a fixed list that suited a cleaner and
not a limousine firm.

## Decision

1. **No fixed prices.** The `pricing.standard_clean_hourly` fact, its card, `PriceCard` and the
   structured-data price are gone. Every call to action is "Request a quote" and links to
   `/quote/`. The Developer's rules forbid prices and tiers. Stored cards for the retired fact read
   as skipped.
2. **One planner call per onboarding turn.** `apps/api/src/onboarding-agent.ts` sends the voice
   guide, the checklist computed from facts, the persona and the owner's new words (as data) and
   gets back a small plan: facts it read, the message to say, and the next step. The model names a
   step or a fact key; code builds every card from the contracts, so it cannot invent options.
3. **Code checks invariants, never words.** Facts parse as `FactValue`, contact details trace to
   what the owner typed, the message carries no price, link, markup or stock-image promise, no
   question repeats a held fact, and the build starts only once the business, persona, design,
   photo and quote steps are settled. One retry with the errors, then the old script answers the
   turn. The script also covers no key, no budget, a frozen conversation, a provider error and a
   timeout.
4. **Cost and logging go through the Chief of Staff's turn log**, so `withinCap` counts planner
   spend. Default model `deepseek/deepseek-v4.1-flash` at low reasoning effort, set by
   `ONBOARDING_MODEL`, chosen by `evals/tier-2/onboarding-planner.eval.mjs`: 13 of 13 messy owners
   set up correctly at about $0.012 an onboarding. The provider is asked for JSON, not a schema:
   constrained decoding on these hosts broke strings and collapsed unions.
5. **Each step is its own message.** A card answer is sent as the owner's own reply, and the next
   step is a new assistant row, so each step has its own time and feedback.
6. **The quote form comes from the owner.** The assistant asks what the business needs to know to
   quote, proposes questions, and the owner confirms them in a `review_quote_form` card. The
   confirmed list is the `quote.form` fact. The seed writes it to `src/quote-form.json` before
   every build, and the Developer may not edit that file. Contact fields stay fixed in the starter.
7. **Design and media.** Three templates of one seed, a researched pool of 16 palettes shown four
   at a time with a colour picker, three system font stacks, a page choice, uploads in R2 under
   `uploads/{org}/` recorded as `media.uploads`, copied into the sandbox, and placed by the
   Developer in the hero, sections, gallery or, for a logo, the header.

## Consequences

- An outage degrades onboarding to the script, not to an error.
- Planner latency is about 5 s at p50 and up to 15 s at p95 on a slow provider, spent in the model's reasoning; the chat shows its pending state meanwhile. Turning reasoning off halves it but tripled invalid plans in the eval, so it stays at low effort.
- The Developer's "no invented specifics" rule is enforced by its own self-check, not by a gate.
- Uploaded photos stay with the org's other rows when an account is deleted, as ADR-035 keeps every
  row; the erasure workflow in §10.5 removes them with the rest.
- When the provider is slow, a turn falls back to the script's wording after 20 seconds; the web
  waits for the whole turn (`CHAT_TURN_MS`), so the owner sees a reply rather than a timeout.
- There is no manual site builder. An owner who skips the build is told so and can ask for the
  build later.

## Change if

- Planner fallbacks exceed one turn in ten on staging over a week, or p95 passes 15 seconds.
- A gate can check service specifics against facts without false positives on the starter's own
  strings.
