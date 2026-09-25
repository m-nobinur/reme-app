import type { ErrorEnvelope } from "@workspace/contracts"

/** R4: every failure leaves as the §28.1 envelope, never a raw exception. */
export function failure(
  status: number,
  envelope: Omit<ErrorEnvelope, "occurred_at">
): Response {
  const body: ErrorEnvelope = {
    ...envelope,
    occurred_at: new Date().toISOString(),
  }
  return Response.json(body, { status })
}

/** The caller's `Idempotency-Key`, or null for a missing or oversized one. */
export function idempotencyKey(request: Request): string | null {
  const key = request.headers.get("idempotency-key")?.trim()
  return key && key.length <= 255 ? key : null
}

export const keyMissing = () =>
  failure(400, {
    class: "validation",
    code: "idempotency_key.missing",
    message: "This request needs an Idempotency-Key header.",
    detail: {},
  })

/** Where a contract parse failed, as dotted paths and never the values. */
export const issuePaths = (issues: { path: PropertyKey[] }[] = []) =>
  issues.map((i) => i.path.join("."))

/** A body the contract refused, naming the paths it refused and nothing else. */
export const invalid = (issues: { path: PropertyKey[] }[]) =>
  failure(400, {
    class: "validation",
    code: "request.invalid",
    message: "The request body does not match the contract.",
    detail: { issues: issuePaths(issues) },
  })
