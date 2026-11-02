import { emailAllowed, parseAccessList } from "@workspace/contracts"
import type { AuthFailure } from "./failure"

const NOT_LISTED: AuthFailure = {
  code: "not_listed",
  message: "Reme is invite-only for now, and this email is not on the list.",
  field: "email",
}

/**
 * The failure for an address that is not on `ALLOWED_EMAILS`, or `null` to let
 * it through. Runs before WorkOS is called, so a stranger creates no account and
 * is sent no email. Unset, everyone passes.
 */
export function refuseUnlisted(email: string): AuthFailure | null {
  return emailAllowed(email, parseAccessList(process.env.ALLOWED_EMAILS))
    ? null
    : NOT_LISTED
}
