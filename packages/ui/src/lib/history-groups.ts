/** The headings a conversation list is split under, newest first. */
type HistoryGroup = "Today" | "Yesterday" | "This week" | "Older"

/**
 * Which heading a conversation sits under, by the calendar day it last moved
 * in the reader's zone: today, yesterday, the five days before that, then
 * older. A time ahead of the clock counts as today.
 */
function historyGroup(at: string, now: Date = new Date()): HistoryGroup {
  const startOf = (daysAgo: number) =>
    new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - daysAgo
    ).getTime()
  const time = Date.parse(at)
  if (time >= startOf(0)) return "Today"
  if (time >= startOf(1)) return "Yesterday"
  if (time >= startOf(6)) return "This week"
  return "Older"
}

export type { HistoryGroup }
export { historyGroup }
