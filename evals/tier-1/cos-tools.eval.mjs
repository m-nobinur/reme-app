import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { CASES, FACTS, partsOf, score } from "../cos-cases.mjs"
import { fixtureLeaks } from "../redact.mjs"
import { canonical, loadFixture } from "../replay.mjs"

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

/**
 * Where the recording no longer matches the cases: a case added, dropped or
 * reworded, or the facts changed, since it was recorded. Scoring a turn
 * against a question it was not asked is noise, so each needs a re-record.
 */
export function drift(fixture) {
  const found = []
  if (canonical(fixture.facts) !== canonical(FACTS))
    found.push("the stated facts")
  const recorded = Object.keys(fixture.sessions).sort((a, b) =>
    a.localeCompare(b)
  )
  const cased = CASES.map((c) => c.name).sort((a, b) => a.localeCompare(b))
  if (canonical(recorded) !== canonical(cased)) found.push("the case list")
  for (const kase of CASES) {
    const names = fixture.sessions[kase.name] ?? []
    const sent = names.map((name) => {
      const { mode, text, deny } = fixture.owner[name]
      return { mode, text, deny }
    })
    if (canonical(sent) !== canonical(kase.turns)) found.push(kase.name)
  }
  return found
}

export default async function cosTools() {
  const leaks = fixtureLeaks(readFileSync(FIXTURE, "utf8"))
  if (leaks.length > 0)
    throw new Error(`cos-chat.jsonl holds ${leaks.join(", ")}`)
  const fixture = loadFixture(FIXTURE)
  const drifted = drift(fixture)
  if (drifted.length > 0)
    throw new Error(
      `cos-chat.jsonl was recorded against other cases (${drifted.join(", ")}). Re-record it on staging; see evals/README.md.`
    )
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
