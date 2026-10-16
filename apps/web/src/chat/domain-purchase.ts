import type { DomainPurchase } from "@workspace/ui/components/assistant/buy-domain"
import { startDomainCheckout } from "@/lib/api/server"
import type { Workspace } from "@/lib/api/types"

/**
 * The buy card's way to open Checkout, and where each purchase stands, from
 * the workspace the chat already polls. Every press opens its own Checkout.
 */
export function domainPurchase(_workspace: Workspace | null): DomainPurchase {
  return {
    checkout: (name, details) =>
      startDomainCheckout({
        data: { name, details, key: crypto.randomUUID() },
      }),
    status: () => null,
  }
}
