import { createFileRoute } from "@tanstack/react-router"
import { DomainName, Uuid } from "@workspace/contracts"
import { source } from "@/lib/api/source"
import { seeOther } from "@/lib/auth/oauth"

/**
 * Where the owner's DNS provider sends the tab back from its Domain Connect
 * page. Unless the provider says it failed or was cancelled, the domain is
 * checked now, which wakes its Workflow, so the assistant says in the chat
 * what it sees within seconds. Either way the owner lands in the conversation
 * they connected from. The check is the owner's own, under their session, so
 * a link someone else made can only look at a domain of theirs.
 */
export const Route = createFileRoute("/api/domains/applied")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const name = DomainName.safeParse(url.searchParams.get("name"))
        const chat = Uuid.safeParse(url.searchParams.get("c"))
        if (name.success && !url.searchParams.has("error")) {
          await source.domainCheck(name.data)
        }
        const back = chat.success ? `/app/c/${chat.data}` : "/app"
        return seeOther(new URL(back, url.origin).href)
      },
    },
  },
})
