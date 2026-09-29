import { createFileRoute } from "@tanstack/react-router"
import policy from "@/content/privacy.md?html"
import { LegalPage } from "@/lib/legal-page"

export const Route = createFileRoute("/privacy")({
  head: () => ({ meta: [{ title: "Privacy policy · Reme" }] }),
  component: () => <LegalPage html={policy} />,
})
