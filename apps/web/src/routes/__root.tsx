import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router"
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
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
