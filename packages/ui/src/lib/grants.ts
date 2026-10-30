import type { GrantKind } from "@workspace/contracts"

/** What a kind's grant lets the assistant do, as the owner reads it. */
export const GRANT_TEXT: Record<GrantKind, string> = {
  create_reminder: "Add reminders you didn't ask for in so many words",
  record_review: "Save a customer's review to your website",
  connect_domain: "Connect a domain you have to your website",
}
