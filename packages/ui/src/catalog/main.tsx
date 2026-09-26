import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { catalog } from "./entries"
import "../styles/globals.css"

// The theme comes from the query string rather than a toggle so that a test can
// ask for one and get it on the first paint, with no click and nothing to settle.
const params = new URLSearchParams(window.location.search)
if (params.get("theme") === "dark") {
  document.documentElement.classList.add("dark")
}

// `?entry=Name` renders that entry alone, so a test can load one at a real
// viewport width without the rest of the catalog around it.
const only = params.get("entry")

const root = document.getElementById("root")
if (root) {
  createRoot(root).render(
    <StrictMode>
      {catalog
        .filter((entry) => !only || entry.name === only)
        .map((entry) => (
          <section
            className="border-border border-b p-6 last:border-b-0"
            data-entry={entry.name}
            key={entry.name}
          >
            <h2 className="mb-4 font-medium text-muted-foreground text-xs uppercase tracking-wide">
              {entry.name}
            </h2>
            {entry.render()}
          </section>
        ))}
    </StrictMode>
  )
}
