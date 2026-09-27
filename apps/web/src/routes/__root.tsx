import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router"
import { formGuardScript } from "@workspace/ui/components/auth-card"
import { themeInitScript } from "@workspace/ui/components/theme-toggle"

import appCss from "@workspace/ui/globals.css?url"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        name: "color-scheme",
        content: "light dark",
      },
      {
        title: "Reme",
      },
      // Images load only from the app, data URLs (the MFA QR code) and any
      // host on remeai.co.uk. That zone holds the signed preview hosts the
      // screenshots come from, but also every tenant site and the api hosts,
      // all of them ours. A backstop for the chat's markdown, which drops
      // images itself. Unsafe once a tenant site answers
      // `{slug}.remeai.co.uk/api/*` (Phase 3, reserved in
      // apps/router/src/index.ts), since an image request could then deliver
      // what its URL carries to that site's API. Screenshots must then come
      // from one fixed host or through 'self', and this narrows to match.
      {
        httpEquiv: "Content-Security-Policy",
        content: "img-src 'self' data: https://*.remeai.co.uk",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    // The theme script adds a class to this element before React hydrates.
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/* Inline and blocking on purpose: it has to set the theme class
            before first paint, or a dark-mode reader gets a white flash. */}
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed literal from this repo, with nothing interpolated into it
          dangerouslySetInnerHTML={{ __html: themeInitScript }}
        />
        {/* Also inline and blocking, and for the same class of reason: it has
            to be listening before the body is parsed, or a submit can happen in
            front of the guard that exists to catch it. See auth-card.tsx. */}
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed literal from this repo, with nothing interpolated into it
          dangerouslySetInnerHTML={{ __html: formGuardScript }}
        />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
