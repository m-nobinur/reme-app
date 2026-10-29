import { appendFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { CASES, partsOf } from "./cos-cases.mjs"
import { loadFixture } from "./replay.mjs"
import { failures, JUDGE_MODEL, judge, table } from "./rubric/behaviour.mjs"
import cosLive, { liveRun } from "./tier-2/cos-live.eval.mjs"

/**
 * The behaviour judge over every Chief of Staff case: one verdict per rule
 * from a model other than the CoS's (see `rubric/behaviour.mjs`), a pass count
 * per rule, and a red exit when a gated case breaks a rule or cannot be graded.
 * Pending cases are graded and shown but never fail the run.
 *
 *   node --import ./evals/json-imports.mjs --experimental-transform-types \
 *     evals/behaviour.mjs [--fixture] [--model ID]
 *
 * By default it runs the cases live on staging, as `tier-2/cos-live.eval.mjs`
 * does (same environment: COS_API_URL, staging's WORKOS_* values and
 * OPENROUTER_API_KEY), then applies that tier's gate to the same run. With
 * `--fixture` it grades the recorded `fixtures/cos-chat.jsonl` instead and
 * needs only OPENROUTER_API_KEY. The table goes to stdout and to
 * `$GITHUB_STEP_SUMMARY` when set.
 */

const arg = (name) => {
  const at = process.argv.indexOf(name)
  return at === -1 ? undefined : process.argv[at + 1]
}

const FIXTURE = fileURLToPath(
  new URL("./fixtures/cos-chat.jsonl", import.meta.url)
)

/** Each recorded case with its turns as `{ owner, parts, outcome }`. */
function recorded() {
  const fixture = loadFixture(FIXTURE)
  return CASES.filter((kase) => fixture.sessions[kase.name]).map((kase) => ({
    kase,
    turns: fixture.sessions[kase.name].map((name) => ({
      owner: fixture.owner[name],
      parts: partsOf(fixture.turns.get(name)),
      outcome: fixture.owner[name].outcome,
    })),
  }))
}

function fromRun(run) {
  return CASES.map((kase) => ({
    kase,
    turns: (run.cases.find((c) => c.name === kase.name)?.turns ?? []).map(
      (t) => ({
        owner: t.owner,
        parts: t.parts ?? partsOf(t.chunks),
        outcome: t.outcome,
      })
    ),
  }))
}

async function grade({ kase, turns }, options) {
  const base = { name: kase.name, pending: Boolean(kase.pending) }
  if (turns.length !== kase.turns.length)
    return {
      ...base,
      error: `${turns.length} of ${kase.turns.length} turns ran`,
    }
  const off = turns.find((t) => t.outcome !== "answered")
  if (off) return { ...base, error: `a turn ended ${off.outcome}` }
  try {
    return { ...base, ...(await judge(kase, turns, options)) }
  } catch (error) {
    return { ...base, error: String(error.message).slice(0, 200) }
  }
}

async function main() {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: not read by any turbo task
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error("OPENROUTER_API_KEY is required")
  const options = { key, model: arg("--model") ?? JUDGE_MODEL }
  const live = !process.argv.includes("--fixture")
  if (live && !process.env.COS_API_URL)
    throw new Error(
      "COS_API_URL names no api; use --fixture to grade the recording"
    )
  const run = live ? await liveRun({ pending: true }) : null
  const cases = run ? fromRun(run) : recorded()
  const graded = []
  for (let i = 0; i < cases.length; i += 6)
    graded.push(
      ...(await Promise.all(
        cases.slice(i, i + 6).map((c) => grade(c, options))
      ))
    )
  const out = table(
    graded,
    graded.reduce((n, g) => n + (g.costUsd ?? 0), 0)
  )
  console.log(out)
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${out}\n`)
  const problems = failures(graded)
  if (run) {
    try {
      await cosLive(run)
    } catch (error) {
      problems.push(`cos-live: ${error.message}`)
    }
  }
  if (problems.length) throw new Error(problems.join("\n"))
}

main().catch((error) => {
  console.error(`FAIL  ${error.message}`)
  process.exitCode = 1
})
