import type { DomainPurchase } from "@workspace/ui/components/assistant/buy-domain"
import { getDomainPurchase, startDomainCheckout } from "@/lib/api/server"

/**
 * The buy card's way to open Checkout and to read where a purchase stands.
 * Every press opens its own Checkout.
 */
export const domainPurchase: DomainPurchase = {
  checkout: (name, details) =>
    startDomainCheckout({ data: { name, details, key: crypto.randomUUID() } }),
  status: (name) => getDomainPurchase({ data: { name } }),
}
