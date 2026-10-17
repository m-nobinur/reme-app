import type { OAuthFlow } from "@/lib/auth/oauth"

/** `openid email` names the connected account; the other two are what Search Console needs. */
export const SCOPES =
  "openid email https://www.googleapis.com/auth/webmasters https://www.googleapis.com/auth/siteverification.verify_only"

/** The connect flow's cookie, scoped to its own two routes, and its callback. */
export const googleFlow = (origin: string): OAuthFlow => ({
  cookie: "reme-google-state",
  path: "/api/google",
  redirectUri: `${origin}/api/google/callback`,
})
