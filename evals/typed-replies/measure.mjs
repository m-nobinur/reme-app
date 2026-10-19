import { readFileSync } from "node:fs"
import { jevApproval, readReply } from "../../apps/api/src/jev.ts"

/**
 * AP2's wrong-path rate: each recorded typed reply over an open card goes
 * the way `chat()` sends it (exact phrase, then the real Jev), and is
 * compared with the path the file labels it with. Under 1 wrong in 20 is the
 * bar. Costs about 40 Jev calls, a fraction of a cent.
 *
 *   node --experimental-transform-types --env-file=<.env.local> evals/typed-replies/measure.mjs
 */

// biome-ignore lint/suspicious/noUndeclaredEnvVars: not passed through turbo, a task that saw the key would run the facade live tests
const key = process.env.OPENROUTER_API_KEY
if (!key) throw new Error("OPENROUTER_API_KEY is not set")

const { cards, replies } = JSON.parse(
  readFileSync(new URL("./replies.json", import.meta.url), "utf8")
)

const wrong = []
for (const { reply, card, kind, path } of replies) {
  // The next `approval.jev` line (approves, declines, asks_change) is this reply's.
  console.log(JSON.stringify({ reply, kind, want: path }))
  const gate = (text) => jevApproval(key, cards[card], text)
  const verdict = await readReply(reply, gate)
  const got = verdict ?? "normal"
  if (got !== path) wrong.push({ reply, kind, want: path, got })
}

const rate = wrong.length / replies.length
console.log(
  JSON.stringify({
    replies: replies.length,
    wrong: wrong.length,
    rate,
    pass: rate < 1 / 20,
    misses: wrong,
  })
)
process.exitCode = rate < 1 / 20 ? 0 : 1
