/**
 * The comparisons, separate from the measuring so a test can drive them. Every
 * case here is one somebody has already shipped past a size gate: a budget file
 * with a typo in a key name, so every comparison is NaN and nothing fails; a
 * bundle that collapsed because a build emitted less, read as an improvement.
 */
export const kib = (bytes) => `${(bytes / 1024).toFixed(2)} KiB`

export function check(size, budget) {
  const numbers = {
    limit: budget?.limit,
    baseline: budget?.baseline,
    drift: budget?.drift,
  }
  const missing = Object.entries(numbers)
    .filter(([, value]) => !Number.isFinite(value) || value <= 0)
    .map(([key]) => key)
  if (missing.length > 0) {
    return {
      summary: "baseline  not compared",
      failure:
        `size: apps/web/size-budget.json has no usable ${missing.join(", ")}. ` +
        "A missing or misspelt key makes every comparison NaN, which passes silently.",
    }
  }

  // wrangler's own figure, when we could read it. Ours is authoritative because
  // it is byte-exact; this only catches the two drifting apart.
  if (size.printed != null) {
    const ours = size.gzip / 1024
    if (Math.abs(ours - size.printed) > 0.02) {
      return {
        summary: `baseline  not compared`,
        failure:
          `size: measured ${ours.toFixed(2)} KiB but wrangler reported ${size.printed.toFixed(2)} KiB. ` +
          "The module set or its concatenation order no longer matches wrangler's, so this number is not what Cloudflare receives.",
      }
    }
  }

  const ceiling = Math.round(budget.baseline * (1 + budget.drift))
  const delta = size.gzip - budget.baseline
  const sign = delta < 0 ? "" : "+"
  const percent = (delta / budget.baseline) * 100
  const summary =
    `baseline ${kib(budget.baseline)}  ${sign}${kib(delta)}  ` +
    `${sign}${percent.toFixed(1)}%  (allowed ${kib(ceiling)})`

  if (size.gzip > budget.limit) {
    return {
      summary,
      failure: `size: over the ${kib(budget.limit)} budget by ${kib(size.gzip - budget.limit)}. Raising it is an ADR.`,
    }
  }
  // Both directions. A collapse is a build that emitted less than it should
  // have, and reporting that as a 100% improvement is how a gate lies.
  if (Math.abs(delta) > budget.baseline * budget.drift) {
    const direction = delta > 0 ? "over" : "under"
    return {
      summary,
      failure:
        `size: ${kib(Math.abs(delta))} ${direction} the baseline, more than the ${(budget.drift * 100).toFixed(0)}% drift allowance.\n` +
        (delta > 0
          ? `Find what was added. If it belongs there, set "baseline": ${size.gzip} in apps/web/size-budget.json\nin this PR and say in the body what the bytes bought.`
          : `A bundle does not shrink by accident. Check the build emitted everything before setting "baseline": ${size.gzip}.`),
    }
  }
  return { summary, failure: null }
}
