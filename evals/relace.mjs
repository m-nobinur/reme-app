import { readFileSync, writeFileSync } from "node:fs"
import { applyEdits } from "../packages/facade/src/edits.ts"
import {
  parseEditsJson,
  parseRecords,
  relacePrompt,
  score,
  summarise,
  table,
  unfence,
} from "./relace/measures.mjs"

/**
 * QE7's replay. Given a JSONL file of recorded edits
 * `{path, original, instruction, expected?}`, runs each through three paths on
 * OpenRouter and prints, per path: apply success, median wall time, changed
 * lines nobody asked for, and cost from the response's `usage.cost`.
 *
 *   node --experimental-transform-types evals/relace.mjs --edits edits.jsonl
 *        [--json out.json] [--dry-run]
 *
 *   haiku-sr    Haiku 5.5 writes {edits:[{oldText,newText}]}, applied by facade's applyEdits
 *   sonnet-sr   the same with Sonnet 5.5
 *   sonnet-relace  Sonnet 5.5 writes a lazy snippet ("// ... keep existing code ..."),
 *                  relace/relace-apply-3 merges it and returns the whole file
 *
 * `expected` is the file as the owner wanted it; without it unrequested lines are
 * not judged (only the changed count). `--dry-run` validates the file and makes no
 * call. Live runs need OPENROUTER_API_KEY. One try per path: no retry, since the
 * quick lane's own retry is a separate measurement. Wall time for sonnet-relace is
 * both calls; its cost is the sum.
 */

const MODELS = {
  haiku: "anthropic/claude-haiku-5.5",
  sonnet: "anthropic/claude-sonnet-5.5",
  relace: "relace/relace-apply-3",
}

const SR_RULES = `You edit one file. Reply with JSON only: {"edits":[{"oldText":"...","newText":"..."}]}.
Each oldText must match the file exactly once, with enough surrounding text to be unique. Change only what the instruction asks.`
const SNIPPET_RULES = `You edit one file. Reply with the changed regions only, as an abbreviated snippet: write each changed region with a little context, and put "// ... keep existing code ..." (use the file's own comment syntax, for CSS /* ... keep existing code ... */, for HTML <!-- ... keep existing code ... -->) wherever you skip unchanged code. No prose, no code fence. Change only what the instruction asks.`

async function chat(model, system, user) {
  const started = performance.now()
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      // biome-ignore lint/suspicious/noUndeclaredEnvVars: not passed through turbo, a task that saw the key would run the facade live tests
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 32000,
      usage: { include: true },
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  })
  const body = await res.json()
  if (!res.ok)
    throw new Error(
      `${model} ${res.status}: ${JSON.stringify(body.error ?? body).slice(0, 200)}`
    )
  return {
    text: body.choices?.[0]?.message?.content ?? "",
    cost: body.usage?.cost ?? 0,
    ms: performance.now() - started,
  }
}

const fileMessage = (r) =>
  `File ${r.path}:\n${r.original}\n\nInstruction: ${r.instruction}`

const PATHS = {
  "haiku-sr": (r) => searchReplace(MODELS.haiku, r),
  "sonnet-sr": (r) => searchReplace(MODELS.sonnet, r),
  "sonnet-relace": async (r) => {
    const snippet = await chat(MODELS.sonnet, SNIPPET_RULES, fileMessage(r))
    const merged = await chat(
      MODELS.relace,
      null,
      relacePrompt(r.instruction, r.original, unfence(snippet.text))
    )
    return {
      result: unfence(merged.text),
      cost: snippet.cost + merged.cost,
      ms: snippet.ms + merged.ms,
    }
  },
}

async function searchReplace(model, r) {
  const got = await chat(model, SR_RULES, fileMessage(r))
  return {
    result: applyEdits(r.original, parseEditsJson(got.text), r.path),
    cost: got.cost,
    ms: got.ms,
  }
}

async function runOne(path, r) {
  const started = performance.now()
  try {
    const out = await PATHS[path](r)
    if (out.result.trim() === "") throw new Error("empty merge")
    return {
      path,
      file: r.path,
      ok: true,
      ms: out.ms,
      cost: out.cost,
      ...score(r.original, out.result, r.expected),
    }
  } catch (e) {
    return {
      path,
      file: r.path,
      ok: false,
      ms: performance.now() - started,
      cost: 0,
      error: e.message,
    }
  }
}

function args(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") opts.dryRun = true
    else if (argv[i].startsWith("--") && argv[i + 1] !== undefined)
      opts[argv[i++].slice(2)] = argv[i]
    else
      throw new Error(
        `bad argument ${argv[i]}; see the header of evals/relace.mjs`
      )
  }
  if (!opts.edits) throw new Error("--edits <file.jsonl> is required")
  return opts
}

async function main() {
  const opts = args(process.argv.slice(2))
  const { records, problems } = parseRecords(readFileSync(opts.edits, "utf8"))
  if (problems.length)
    throw new Error(`${opts.edits}:\n  ${problems.join("\n  ")}`)
  if (opts.dryRun) {
    for (const r of records)
      console.log(
        `${r.path}  ${r.original.split("\n").length} lines  expected: ${r.expected === undefined ? "no" : "yes"}`
      )
    console.log(
      `ok: ${records.length} edits x ${Object.keys(PATHS).length} paths, no calls made`
    )
    return
  }
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: not passed through turbo, a task that saw the key would run the facade live tests
  if (!process.env.OPENROUTER_API_KEY)
    throw new Error("OPENROUTER_API_KEY is not set")
  const rows = []
  for (const r of records) {
    // Serial on purpose: wall time is the measurement, parallel calls would blur it.
    for (const path of Object.keys(PATHS)) {
      const row = await runOne(path, r)
      rows.push(row)
      console.log(
        `${path.padEnd(14)} ${r.path}  ${row.ok ? "applied" : `FAILED ${row.error}`}`
      )
    }
  }
  console.log(`\n${table(summarise(rows))}`)
  if (opts.json) writeFileSync(opts.json, `${JSON.stringify(rows, null, 2)}\n`)
}

main().catch((e) => {
  console.error(e.message)
  process.exitCode = 2
})
