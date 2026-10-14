# ADR-039: Generated photos fill atmosphere, never a claim, and an owner's photo always wins

Status: accepted, 2026-10-14. Applies to `apps/orchestrator`, `apps/api`, `packages/gates`,
`packages/contracts`, `packages/db` and `packages/starter-site`. Amends ADR-033's generation-side
rules on images. Sits beside the track's model table, which names the photo model.

## Context

A business with no uploads gets no image at all: the starter's hero falls back to an icon list.
The two reference sites the owner picked lean on photos, four empty sunlit interiors on one and a
single warm hero on the other.

ADR-033 says the facts decide what is true and the owner decides what the site shows. A photo
sits on both sides of that line. A sunlit room says nothing checkable. A smiling cleaner under
"our team", a van under "our fleet" or a tidy kitchen under "our work" says something about the
business that nobody has checked. The sandbox cannot generate either: its egress is the npm
registry only and it holds no key (ADR-031), so generation runs in the orchestrator Worker.

## Decision

1. **What may be generated.** Interiors, surfaces, objects, materials, tools, streets, skylines,
   vehicles as general atmosphere, hands at work, and people from behind or at a distance.
2. **What may not.**
   - A face presented as the business's staff or customer.
   - Anything in a team, fleet, gallery-of-work, before-and-after, review or credential section.
   - Text, logos, signage, number plates or brand badges.
   - Anything that depicts a claim: a certificate, an award, a price.

   A limousine fleet is a claim about what the business owns, so fleet photos are uploads only.
   Every generation prompt ends with this list.
3. **Owner uploads always win a slot.** A generated photo fills only a slot with no upload.
   Uploads go in as reference images when they exist, so a generated room sits next to the
   owner's real photos.
4. **Provenance.** `ImageSlot.source` is `generated`. The asset row stores the model id, the
   prompt hash and the cost. The review screen badges a generated photo. The owner can swap it
   for an upload, ask for another, or remove it, and removing it picks the section's no-image
   variant.
5. **The claims gate learns one rule.** A `generated` slot in a claim section fails the build
   with the slot as the node, the way an unsourced price does. The claim sections are `about`
   (where a team photo lives), `gallery` and `testimonials`, and `service_cards` in the `fleet`
   variant. The rule reads the Blueprint's slots and page sections, not pixels: the gate cannot
   tell a generated photo from a real one in a built page, so what it checks is where the plan
   put one.
6. **Where and how it runs.** The photo director runs in the orchestrator Worker. Haiku 5.5 at
   low effort writes the prompts: one shared style line for the set, then a subject line per
   slot. `google/gemini-nano-banana-2.1` generates through OpenRouter's `POST /api/v1/images`.
   The hero goes first at 2K, then the rest at 1K, at most four at once, with the hero as a
   reference image so the grade matches.
7. **Storage and reuse.** R2 `generated/{org}/{assetId}.{ext}`, in the bucket uploads use. A slot
   whose prompt hash already has an asset for the org reuses it, so a rebuild does not pay twice.
   Account deletion (ADR-035) deletes generated assets with the uploads.
8. **Caps.** At most eight generated photos per first build, one of them 2K (about $0.29). At
   most 30 generations per org per day. A cap that is hit leaves the slot to the fallback; it
   does not fail the build.
9. **Failure.** A refused or failed slot retries once with its subject simplified, then falls back
   to the section's no-image variant. A build never fails for a photo.

## Consequences

- A site with no uploads gets a hero and atmosphere photos. It never gets a stranger's face
  labelled as a person who works there.
- Photographic proof of work stays with the owner. A gallery, a team page and a fleet are empty
  until the owner uploads.
- The gate checks the plan, so a builder that writes a generated file into a claim section
  without a slot is not caught by this rule. The never-list in the prompt and the review badge
  are the other two guards. A site-level scan of built images belongs with the design critic.
- Generated assets add a cost line per build, from the billed-cost tap. At eight photos it is
  about $0.29.
- Latency per resolution is not published; the photo director's first recorded run sets it.

## Change if

- The owner decides generated faces from behind or at a distance are still too close to a claim
  (index, owner decision 1), in which case point 1 drops people.
- The photo director's refusal rate on the three industry fixtures passes one slot in five.
- A reviewer finds a generated photo in a claim section that the gate passed.
