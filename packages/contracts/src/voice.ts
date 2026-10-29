/**
 * A dash read as a pause becomes a comma; one in a range becomes "to": a
 * figure, perhaps with a unit (10%, 9am, 5k), then a figure, perhaps after a
 * currency sign, so "£80–£150" is "£80 to £150". Every model-written line
 * the owner reads goes through it: the chat as it streams, and the
 * orchestrator's messages and emails.
 */
export const dashesToCommas = (text: string): string =>
  text
    .replace(/(\d[%a-zA-Z]{0,3})\s*[—–]\s*([£$€]?\d)/g, "$1 to $2")
    .replace(/\s*[—–]\s*/g, ", ")
