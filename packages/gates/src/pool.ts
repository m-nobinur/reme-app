/**
 * A limiter: `limit(n)` returns a function that runs a task once fewer than
 * `n` of its tasks are in flight, and queues it until then. A finished task
 * hands its slot straight to the next in line, so the count never overshoots.
 */
export function limit(max: number) {
  let active = 0
  const waiting: (() => void)[] = []
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= max)
      await new Promise<void>((resolve) => waiting.push(resolve))
    else active++
    try {
      return await task()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}
