import type { DomainPurchase } from "@workspace/ui/components/assistant/buy-domain"
import {
  buyDomainElsewhere,
  getDomainPurchase,
  getDomainRegistrant,
  startDomainCheckout,
} from "@/lib/api/server"

/**
 * The buy tray's calls to the api. Every Pay opens its own Checkout; the
 * buy-elsewhere note is keyed per press too.
 */
export const domainPurchase: DomainPurchase = {
  registrant: (name) => getDomainRegistrant({ data: { name } }),
  checkout: (name, details) =>
    startDomainCheckout({ data: { name, details, key: crypto.randomUUID() } }),
  status: (name) => getDomainPurchase({ data: { name } }),
  elsewhere: async (name) => {
    await buyDomainElsewhere({ data: { name, key: crypto.randomUUID() } })
  },
}
