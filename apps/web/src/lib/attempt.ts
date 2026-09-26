/**
 * Idempotency keys for one form: the same key for every press while the
 * input is unchanged, so a retry after a timeout is the same request, and a
 * new one once the input changes or the write succeeded.
 */
export function attemptKeys() {
  let sent: string | null = null
  let current = ""
  return {
    key(input: unknown): string {
      const next = JSON.stringify(input)
      if (next !== sent) {
        sent = next
        current = crypto.randomUUID()
      }
      return current
    },
    done() {
      sent = null
    },
  }
}
