/**
 * Where a flow is allowed to send the browser afterwards.
 *
 * `?returnTo=` is attacker-controlled: it survives a link in an email, and the
 * page it lands on is one the person has just typed a password into, which is
 * exactly the position an open redirect is worth something from. So the only
 * values that survive are in-app absolute paths.
 *
 * `//evil.example` is the case a naive `startsWith("/")` check lets through:
 * the browser reads a protocol-relative URL as another origin. `/\evil` is the
 * same trick with the slash some parsers normalise, and a control character can
 * hide either from a check written against printable input.
 */
const FALLBACK = "/app"

// C0 controls and DEL. A tab or a newline inside the value is enough to slip a
// second header or a different parse past a printable-only check.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const CONTROL = /[\u0000-\u001f\u007f]/

export function safeReturnTo(value: unknown, fallback = FALLBACK): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    return fallback
  }
  if (CONTROL.test(value)) {
    return fallback
  }
  if (!value.startsWith("/")) {
    return fallback
  }
  // Protocol-relative, in either slash.
  if (value.startsWith("//") || value.startsWith("/\\")) {
    return fallback
  }
  return value
}
