import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router"
import { DomainName } from "@workspace/contracts"
import { PageHeader } from "@workspace/ui/components/app-shell"
import { buttonVariants } from "@workspace/ui/components/button"
import { lastChat } from "@/chat/history"

/**
 * Where Stripe sends the owner after paying for a domain in Checkout, when
 * the payment needed to leave the page. Stripe only comes here once
 * Checkout is complete, which for a hold means the card was authorised.
 * This page fulfils nothing: the purchase moves on from Stripe's signed
 * webhook alone, and the assistant reports in the chat, so the page says
 * that and leads back to the newest conversation.
 */
export const Route = createFileRoute("/app/domains/return")({
  validateSearch: (search: Record<string, unknown>): { name?: string } => {
    const name = DomainName.safeParse(search.name)
    return name.success ? { name: name.data } : {}
  },
  component: DomainReturn,
})

const frame = getRouteApi("/app")

function DomainReturn() {
  const { name } = Route.useSearch()
  const { conversations } = frame.useLoaderData()
  const chat = lastChat(conversations)
  const action = buttonVariants({ size: "sm" })
  return (
    <div className="mx-auto w-full max-w-xl px-4 pt-10">
      <PageHeader
        description={`Your card is authorised. Nothing is taken until ${name ?? "the domain"} is registered, and if that fails the hold is released. I'll message you in the chat when it's done.`}
        title="Payment approved"
      />
      {chat ? (
        <Link className={action} params={{ id: chat.id }} to="/app/c/$id">
          Back to the chat
        </Link>
      ) : (
        <Link className={action} to="/app">
          Go to the chat
        </Link>
      )}
    </div>
  )
}
