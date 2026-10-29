export function activeMs(output) {
  const active = /Active:\s*([\d.]+)\s*ms/.exec(output)?.[1]
  return active === undefined ? null : Number(active)
}

export function startupProblem(output, ceilingMs, profile) {
  const active = activeMs(output)
  if (active === null || !Number.isFinite(active)) {
    return `wrangler check startup printed no parseable "Active: <n> ms" line. The profile is at ${profile}.`
  }
  if (active > ceilingMs) {
    return `startup CPU is ${active} ms, over the ${ceilingMs} ms ceiling. The profile is at ${profile}; load it in Chrome DevTools to see which function spent the time.`
  }
  return null
}
