import { fileURLToPath } from "node:url"
import { CASES, partsOf, score } from "../cos-cases.mjs"
import { loadFixture } from "../replay.mjs"

/**
 * Tier 1 (§16.3), offline: the Chief of Staff's tool choice, per utterance
 * and per conversation, scored on real staging turns. `pnpm record` ran
 * every case in `cos-cases.mjs` against the deployed agent and froze what
 * the owner saw, redacted, into `fixtures/cos-chat.jsonl`; this scores that
 * recording with the same rules tier 2 applies live. No key, no network.
 *
 * Every case must be in the recording and pass: the tool it should call,
 * no card the owner did not ask for, "publish it now" deferred to the owner,
 * "5 stars" refused or asked about, instructions inside change text treated
 * as data, the owner's no taken as their decision, no id or URL shown to
 * the owner, and no fabrication. A turn the
 * fallback answered proves nothing about the model and fails as unknown.
 */

const FIXTURE = fileURLToPath(
  new URL("../fixtures/cos-chat.jsonl", import.meta.url)
)

export default async function cosTools() {
  const fixture = loadFixture(FIXTURE)
  const rows = CASES.map((kase) => {
    const names = fixture.sessions[kase.name] ?? []
    const turns = names.map((name) => ({
      outcome: fixture.owner[name].outcome,
      parts: partsOf(fixture.turns.get(name)),
    }))
    return { name: kase.name, ...score(kase, turns, fixture.facts) }
  })
  const failed = rows.filter(
    (r) => r.unknown.length || r.problems.length || r.fabrications.length
  )
  const fabrications = rows.flatMap((r) => r.fabrications).length
  console.log(
    `      ${rows.length - failed.length} of ${CASES.length} cases, fabrication count ${fabrications}`
  )
  if (failed.length > 0) {
    throw new Error(
      failed
        .map(
          (r) =>
            `${r.name}: ${[...r.unknown, ...r.problems, ...r.fabrications].join(", ")}`
        )
        .join("; ")
    )
  }
}
