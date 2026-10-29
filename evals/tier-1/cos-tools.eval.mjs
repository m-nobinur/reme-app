import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { FACTS, GATED, partsOf, passed, score } from "../cos-cases.mjs"
import { serialise } from "../record.mjs"
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
  const cased = GATED.map((c) => c.name).sort((a, b) => a.localeCompare(b))
  if (canonical(recorded) !== canonical(cased)) found.push("the case list")
  for (const kase of GATED) {
    const names = fixture.sessions[kase.name] ?? []
    const sent = names.map((name) => {
      const { mode, text, deny } = fixture.owner[name]
      return { mode, text, deny }
    })
    if (canonical(sent) !== canonical(kase.turns)) found.push(kase.name)
  }
  return found
}

/**
 * The recorder redacts a value the stream split across chunks: a UUID, a
 * ULID and a host, each cut in two, must come out as markers, and the
 * scan must pass what it writes.
 */
function splitValuesRedacted() {
  const cut = [
    ["3f1c2a4e-1111-4222-", "8333-444455556666"],
    ["01K6ABCDEFGH", "JKMNPQRSTVWXYZ"],
    ["reme-api.nobin.workers", ".dev/x"],
  ]
  const chunks = cut.flatMap(([a, b]) => [
    { type: "text-delta", id: "t", delta: ` ${a}` },
    { type: "text-delta", id: "t", delta: b },
  ])
  const { text } = serialise({
    cases: [
      {
        name: "split",
        turns: [
          { owner: { mode: "ask", text: "q" }, chunks, outcome: "answered" },
        ],
      },
    ],
    builds: 0,
    spentUsd: 0,
    stopped: null,
    secrets: [],
  })
  const delta = JSON.parse(text.split("\n")[1]).chunk.delta
  if (delta !== " REDACTED-uuid-1 REDACTED-ulid-1 REDACTED-host-1/x")
    throw new Error(`a split value was not redacted whole: ${delta}`)
}

export default async function cosTools() {
  splitValuesRedacted()
  const leaks = fixtureLeaks(readFileSync(FIXTURE, "utf8"))
  if (leaks.length > 0)
    throw new Error(`cos-chat.jsonl holds ${leaks.join(", ")}`)
  const fixture = loadFixture(FIXTURE)
  const drifted = drift(fixture)
  if (drifted.length > 0)
    throw new Error(
      `cos-chat.jsonl was recorded against other cases (${drifted.join(", ")}). Re-record it on staging; see evals/README.md.`
    )
  const rows = GATED.map((kase) => {
    const names = fixture.sessions[kase.name] ?? []
    const turns = names.map((name) => ({
      outcome: fixture.owner[name].outcome,
      parts: partsOf(fixture.turns.get(name)),
    }))
    return { name: kase.name, ...score(kase, turns, fixture.facts) }
  })
  const failed = rows.filter((r) => !passed(r))
  const fabrications = rows.flatMap((r) => r.fabrications).length
  console.log(
    `      ${rows.length - failed.length} of ${GATED.length} cases, fabrication count ${fabrications}`
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
