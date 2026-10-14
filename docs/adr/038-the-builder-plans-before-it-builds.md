# ADR-038: The builder plans a Blueprint before it builds, and builds it with subagents

Status: accepted, 2026-10-14. Applies to `apps/orchestrator`, `apps/api`, `packages/facade`,
`packages/contracts`, `packages/db` and `packages/starter-site`. Amends ADR-036: an owner's first
build now waits for one more approval, the Blueprint card, before any file is written. Sits beside
ADR-039 (generated photos) and ADR-040 (the quick edit lane).

## Context

Every business got nearly the same site. The starter rendered one fixed section order, three
templates changed type and radius only, colour was one hex, fonts were system stacks, and
industry changed the hero eyebrow and nothing else. Ten cleaning businesses that skipped the
pickers got the same teal site.

The builder did not plan. `planning` was a database transition. One Sonnet session at high effort
read the facts and edited files until it reported, and flue's `task` tool was refused, so there
were no subagents. The owner saw nothing of the design until a preview existed, minutes and a few
dollars later.

## Decision

1. **A plan comes first.** A first build, and a revise whose change kind is `creative`, runs one
   planning call before the Developer starts. It returns a CT1 `Blueprint`: the direction, the
   font pair, the palette, each page's sections in order with a variant each, the image slots, the
   copy voice and a feature list in plain words. The quick lane and other revises do not plan.
2. **One structured call, never a blocker.** The `plan` role (Sonnet 5.5, high effort, 32k) is
   asked for the Blueprint as structured output. The JSON Schema sent is the contract's with the
   keywords Claude's structured outputs refuse removed; the contract parses the reply in full.
   Rules a schema cannot state are code: pages unique and exactly the business's pages with home
   and quote, each section a kind its page may hold, slot ids unique, uploads the owner's own, no
   generated photo where a photo is a claim (ADR-039), a direction from the library, and at most
   two of the direction's axes changed. A reply that fails gets one retry with what was wrong.
   A second failure, or a provider that does not answer, gets a Blueprint built by code from the
   industry pack's order and a direction for the industry. A model failure never blocks a build.
3. **The owner's stated answers win.** A palette or font the owner stated in onboarding
   (`owner_stated` provenance) is applied over the model's choice in code. A value the assistant
   picked for them is a hint the plan may change. `site.template` is not forced onto the
   direction: every onboarded owner holds one, so forcing it would collapse every site onto three
   directions.
4. **Sites in one industry differ on purpose.** Code, not the model, writes a diversity note: the
   direction and home hero and services variants of up to 20 other businesses in the same
   industry, newest first, one row per business, read from their planned builds' revisions. The
   planner is told to plan a combination not on the list; the code fallback takes the direction
   recent sites used least. The read crosses tenants, so it is a `SECURITY DEFINER` function
   (`recent_designs`, migration 0014) that returns three library ids per row and nothing else:
   no org id, no name, no text a business wrote, and never the caller's own org. It is declared
   in the tenancy suite like the other definers, with its row shape as the probe.
5. **The Blueprint is stored and shown.** It lives on the assignment (`assignments.blueprint`,
   jsonb, the latest round's), with a `blueprint.proposed` event per round carrying the round,
   whether it came from the model or the fallback, and the plan it changed. The workspace frame
   carries it on the build (`BuildSummary.blueprint`: the plan, its round, the previous plan,
   and whether the build waits on the owner) for the card (OI4).
6. **The owner decides; the Workflow waits.** An owner's build waits after each round, in
   `planning`, for "Build it" or "Change something". The decision arrives at the orchestrator
   bridge (`POST /assignments/:id/blueprint`, body `BlueprintReviewOutput`), is stored as
   `blueprint.decided` for that round, and nudges the Workflow with a `blueprint` event. As with
   answers, the stored row is the truth and the nudge only makes the Workflow look now; it looks
   every six hours regardless. "Change something" re-plans from the current Blueprint with the
   owner's words as data, up to six plans per build; past that the bridge refuses a change, so the
   owner builds or cancels. No decision in seven days fails the build from `planning`, which
   releases the site lock. A console build plans and does not wait. "Skip all" on the onboarding
   tray (`review: "skip"` on the create request) plans and does not wait either.
7. **A creative change re-plans.** Its first round starts from the newest Blueprint the org has,
   with the change request as the note. If that re-plan fails, the plan it was changing stands;
   the Developer still receives the owner's words as its goal.
8. **The Developer builds the Blueprint.** It is in the brief, after the facts: the direction,
   pair and palette, the voice, the exact `layout` export for `site-config` with every variant
   written out (an inner page's hero is the plain page hero unless `layout` names one), each
   section's purpose, the image slots and the feature list. Where it differs from the owner's
   choices listed above it, the Blueprint wins, because it already applied them.
9. **Subagents.** flue's `task` tool and `useSubagent`, which the facade already ships, are no
   longer refused. Page builders, a copy writer, the photo director and a critic may run under one
   lead, at most four at once. Children cannot call `task`, `checkpoint`, `report_complete` or
   `ask_chief`, cannot run `astro build`, write files through a per-path queue, and charge the
   assignment's one budget. BA1 records the turn-gate details.
10. **Runtime models.** One role, one effort, so cached prefixes hold: Sonnet 5.5 for planning
    (high) and for the lead and page builders (medium, sharing a prefix), Haiku 5.5 for copy and
    small single-shot work, the design critic on Sonnet 5.5 at medium. The track index holds the
    table; photos are ADR-039's.
11. **Fonts are self-hosted.** Pairs are woff2 files baked into the sandbox image, served by the
    site itself. No font CDN, so the sandbox stays offline and the CSP is unchanged.
12. **Templates stay components, with an escape hatch.** Variants inside the starter's components
    come first. A Blueprint may name at most two custom sections, written under
    `src/components/custom/`, which pass the same gates plus axe in the sandbox.
13. **The library is data.** Directions are VS6's `src/directions.json`, parsed by
    `DesignDirection` when the Worker loads. Until that file exists, two stand-in directions from
    VS6's starting set are the library, and the file drops in with no code change.

## Consequences

- The owner sees the design and the page plan before anything is built, and every first build
  pays one more Sonnet call, two on a retry. Its cost is unmeasured until a recorded run; the
  `runtime.turn` rows tagged `plan` meter it with the rest of the build.
- An owner's build holds its site lock and its provisioned container while it waits on the card.
  The container sleeps on its own and a first build reseeds anyway, but a pool slot may stay
  taken; index open item 1 covers pool pressure.
- The plan and the built site can be compared by code (index exit gate 3).
- The fallback means a provider outage yields a plainer site, not a stopped build. The log says
  which builds fell back.
- The diversity note sees only builds that planned and passed the gates. Old sites are invisible
  to it until they re-plan.
- One more cross-tenant read exists. Its body is the boundary, as with every definer.

## Change if

- The owner decides the card should not gate onboarding builds (index, owner decision 2).
- EV1 shows sites in one industry still converge, which would move diversity from a note to a
  rule the plan check enforces.
- The plan call's fallback rate on the industry fixtures passes one build in ten.
- A second site per org arrives, which changes what "the org's newest Blueprint" means for a
  creative change.
