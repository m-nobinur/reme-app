import { createFileRoute } from "@tanstack/react-router"
import terms from "@/content/terms.md?html"
import { LegalPage } from "@/lib/legal-page"

export const Route = createFileRoute("/terms")({
  head: () => ({ meta: [{ title: "Terms of service · Reme" }] }),
  component: () => <LegalPage html={terms} />,
})
