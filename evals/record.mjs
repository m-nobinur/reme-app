import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { replay } from "./replay.mjs"

/**
 * `pnpm record` writes the recorded fixture set the eval runner replays.
 *
 * The only source of recorded model output in the repo today is the mock Chief
 * of Staff conversation the chat surface streams, so that is what this records:
 * the same chunks, in the same order, frozen into a file the runner reads
 * without reaching into an app. Re-run it when the recording changes and read
 * the diff, which is the whole point of a golden fixture.
 *
 * This file is the only thing in `evals/` that reaches into `apps/web`. CI runs
 * it on every PR and fails when the fixture it writes differs from the one in
 * the tree, so a recording change has to be committed with its diff. When a
 * real runtime replaces the mock, this is what gets repointed at it.
 */

const SOURCE = "../apps/web/src/chat/recorded-conversation.ts"

const FIXTURE = {
  fixture: "cos-chat",
  turns: ["opening", "approved", "denied"],
  // The recording branches on the owner's answer, so it is two sessions over
  // three turns. Replaying a whole session rather than a turn is what resolves
  // the publish tool call, which is opened in `opening` and answered later.
  sessions: {
    approve: ["opening", "approved"],
    deny: ["opening", "denied"],
  },
}

const OUT = fileURLToPath(new URL("./fixtures/cos-chat.jsonl", import.meta.url))

const recorded = await import(new URL(SOURCE, import.meta.url).href)
const source = {
  opening: recorded.OPENING,
  approved: recorded.APPROVED,
  denied: recorded.DENIED,
}

// `delayMs` is dropped. It is how fast the mock streams to a human, and a
// number nothing reads is a number someone will eventually hash.
const lines = FIXTURE.turns.flatMap((turn) =>
  source[turn].map(({ chunk }) => JSON.stringify({ turn, chunk }))
)

const turns = new Map(
  FIXTURE.turns.map((turn) => [turn, source[turn].map(({ chunk }) => chunk)])
)
const hash = replay({ ...FIXTURE, turns })

writeFileSync(
  OUT,
  `${[JSON.stringify({ ...FIXTURE, hash }), ...lines].join("\n")}\n`
)
console.log(`recorded ${OUT}`)
console.log(`  ${lines.length} chunks, ${hash}`)
