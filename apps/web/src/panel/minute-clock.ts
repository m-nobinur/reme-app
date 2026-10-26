let now = Date.now()

/**
 * Ticks when the wall clock's minute turns, then every 60 s, so an elapsed
 * time moves on the minute rather than 60 s after the panel mounted. The
 * snapshot is the real time at the tick, not the floored minute.
 */
export const everyMinute = (tick: () => void) => {
  let every: ReturnType<typeof setInterval> | undefined
  const turn = () => {
    now = Date.now()
    tick()
  }
  now = Date.now()
  const first = setTimeout(
    () => {
      turn()
      every = setInterval(turn, 60_000)
    },
    60_000 - (now % 60_000)
  )
  return () => {
    clearTimeout(first)
    clearInterval(every)
  }
}

export const thisMoment = () => now
