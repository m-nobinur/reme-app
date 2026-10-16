# ADR-040: Small changes run in a quick lane on a warm sandbox, and the gates stay whole

Status: accepted, 2026-10-14. Applies to `apps/orchestrator`, `apps/api`, `packages/contracts`,
`packages/facade` and `packages/gates`. Leaves §8.4's "Revising always re-runs full Validating"
standing: the lane shortens the model work and the I/O around it, never the gates.

## Context

An owner's "change the hero title" read 3 min 24 s and still building. A revise ran the first
build's whole pipeline: a fresh sandbox (the last one was destroyed), the source tar restored
twice, a full Sonnet session at high effort, `astro check` and `astro build` run by the model and
again by `report_complete`, three screenshots taken inside the tool, every dist file uploaded one
at a time, all gates, then review. Most revises are a sentence, a phone number or a colour.

## Decision

1. **A change has a kind.** `ChangeKind` is `copy`, `style`, `section`, `photo` or `creative`
   (`packages/contracts/src/owner.ts`). The Chief of Staff fills it in the `request_change` call it
   already makes; `/changes` and chat approval carry it to `startChange` and on to the
   orchestrator. A steer drops it. Missing or unknown reads as `creative`.
2. **Two lanes.** `pickLane` sends a `site.revise` of kind `copy`, `style`, `section` or `photo`
   to the quick lane. A first build, `creative`, or anything unknown runs the full lane, so a
   wrong guess costs time and never a broken site. Lane and kind ride the `assignment.created`
   payload (no migration) and the `revise.timing` line.
3. **A warm sandbox per site.** The sandbox is keyed by `org_id`; the site lock makes that safe.
   After `preview_ready` the Workflow keeps it warm instead of destroying it, writing a revision
   marker on the disk and a holder entry in R2. A Cloudflare Container's disk does not survive
   sleep, so warm means awake: `SLEEP_AFTER` is 30 minutes, one constant, both the warm TTL and
   the idle sleep. The next revise maps a matching disk without restoring it; any other disk is
   wiped and restored once. A full pool evicts the least recently edited warm sandbox. Rollback
   and takedown invalidate by revision mismatch and by destroying the site's sandbox.
4. **One cheap call for words and tokens.** `copy` and `style` make one model call outside the
   agent loop (`completeOnce`, same providers and cost tap) on Haiku 5.5 at low effort, 4k
   tokens, structured output, the builder's rules as a one-hour cached system prompt, the owner's
   words tainted in the user part. It returns point edits applied to `src/site-config.ts` (and
   `src/styles/theme.css` for `style`); nothing else is writable. `photo` redraws one slot
   (`regenerateSlot`, ADR-039) from the `site.photos` event, five a day per slot.
   `section` goes to the Developer at Sonnet low effort with no planner.
5. **Fall through, never fail.** A failed apply retries once on Sonnet with the error. An apply
   or build failure, a failed gate or a missing prerequisite (no photo record, an ambiguous slot)
   resets the disk and hands the change to the Developer at `quick_section`, which steps up to the
   build role on its first repair. The owner waits longer; the site is never left half edited.
6. **The tail is shared and cheaper.** `finishRevision` (one check, one build, axe, changed-only
   uploads, source tar) serves both lanes. Uploads hash in the sandbox and copy unchanged files
   from the site's newest earlier manifest, eight at a time. Screenshots move to a Workflow step
   after gates and review.
7. **Gates unchanged.** Every gate still runs in full on every revision, including the quick
   lane's, in parallel as before. Review still runs. Nothing in the lane may skip or soften one.

## Consequences

- The lane's targets, from the track's exit gate, are copy change to `preview_ready` p50 at or
  under 20 s and p95 at or under 45 s, token change p50 at or under 40 s, and a quick edit at or
  under $0.02. They are targets: the five canned edits on staging against QE1's baseline are still
  owed, and this record is amended with the numbers when they land.
- A warm sandbox holds one of the pool's five slots for up to 30 minutes after an edit. Pool
  pressure and the idle cost are unmeasured; the owner decides whether to raise `max_instances` or
  shorten the TTL.
- The model's own `astro build` stays in the section lane for its copy check; check and build do
  not run in parallel because `standard-2` has one vCPU and both write `.astro`.
- `revise.timing` carries `lane`, `change_kind`, `quick` (done or fell), `warm` and the step
  times, and `evals/latency.mjs` turns them into p50 and p95 per lane.

## Change if

- The quick lane falls through on more than one change in four over a week on staging; the kind
  guess or the apply step is wrong and the lane is costing time instead of saving it.
- Warm sandboxes make a first build wait for a pool slot.
- Relace Apply 3 (QE7's spike) beats the Sonnet retry on merge accuracy and latency for large
  files.
