import { DICTATION_TIDY_MS } from "@workspace/contracts"
import { expect, it } from "vitest"
import { sideModel, tidy } from "../src/tidy.ts"
import { CASES } from "./tidy-cases.ts"

/**
 * The side model, for real: the benchmark's tidy cases through the Worker's
 * own `tidy`, twice so the second round reads the prompt cache. Well under a
 * cent a run, so it is not part of the suite: it runs with
 * `TIDY_LIVE=1 OPENROUTER_API_KEY=…` and prints the host, latency, tokens and
 * cached share of every call.
 */
const live = process.env.TIDY_LIVE && process.env.OPENROUTER_API_KEY

it.skipIf(!live)(
  "passes every benchmark case within the time, on a pinned host",
  { timeout: 60_000 },
  async () => {
    const model = sideModel(process.env.OPENROUTER_API_KEY as string)
    const logged: {
      ms: number
      provider: string | null
      input_tokens: number
      cached_tokens: number
      cost_usd: number | null
    }[] = []
    const log = console.log
    console.log = (line: string) => {
      try {
        logged.push(JSON.parse(line))
      } catch {
        log(line)
      }
    }
    const rows: string[] = []
    // The first call of a process pays for the connection; it is not a pass.
    await tidy(model, "um hello", 10_000)
    try {
      for (const round of [1, 2]) {
        for (const c of CASES) {
          const out = await tidy(model, c.input, 10_000)
          const call = logged.at(-1)
          rows.push(
            `${round} ${c.id.padEnd(12)} ${String(call?.ms).padStart(5)} ms  ${String(call?.provider).padEnd(10)} cached ${call ? Math.round((call.cached_tokens / call.input_tokens) * 100) : "?"}%  $${call?.cost_usd}  ${call && call.ms <= DICTATION_TIDY_MS ? "in time" : "LATE"}  ${JSON.stringify(out)}`
          )
          expect(out, c.id).not.toBeNull()
          expect(c.check(out ?? ""), `${c.id}: ${out}`).toBe(true)
        }
      }
    } finally {
      console.log = log
      console.log(rows.join("\n"))
    }
  }
)
