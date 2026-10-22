import { useEffect, useState } from "react"

/**
 * One of `items` at a time, the next every `ms` while there are two or more
 * and nothing holds it, so lines that share one place each get a turn.
 */
export function useCycle<T>(
  items: readonly T[],
  ms: number,
  held = false
): { item: T | undefined; at: number } {
  const [at, setAt] = useState(0)
  const count = items.length
  useEffect(() => {
    if (count < 2 || held) return
    const timer = setInterval(() => setAt((each) => each + 1), ms)
    return () => clearInterval(timer)
  }, [count, ms, held])
  const index = count ? at % count : 0
  return { item: items[index], at: index }
}
