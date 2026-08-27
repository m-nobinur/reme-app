import { createFileRoute } from "@tanstack/react-router"
import { beginOAuth, isSupportedProvider, seeOther } from "@/lib/auth/oauth"
import { safeReturnTo } from "@/lib/auth/redirect-target"
import { workos } from "@/lib/auth/workos"

export const Route = createFileRoute("/api/auth/social")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const url = new URL(request.url)
        const provider = url.searchParams.get("provider")
        if (!isSupportedProvider(provider)) {
          return seeOther(new URL("/sign-in?error=provider", url.origin).href)
        }
        const { state, redirectUri } = beginOAuth(
          safeReturnTo(url.searchParams.get("returnTo"))
        )
        return seeOther(
          workos().userManagement.getAuthorizationUrl({
            provider,
            redirectUri,
            state,
          })
        )
      },
    },
  },
})
