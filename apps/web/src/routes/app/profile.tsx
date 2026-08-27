import { BuildingsIcon } from "@phosphor-icons/react"
import { createFileRoute } from "@tanstack/react-router"
import type { FactRecord } from "@workspace/contracts"
import { PageHeader } from "@workspace/ui/components/app-shell"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import {
  type DefinitionItem,
  DefinitionList,
} from "@workspace/ui/components/definition-list"
import { EmptyState } from "@workspace/ui/components/empty-state"
import { formatDate, formatMoney } from "@workspace/ui/lib/format"
import { getBusinessProfile } from "@/lib/api/server"

export const Route = createFileRoute("/app/profile")({
  loader: async () => await getBusinessProfile(),
  component: Profile,
})

function Profile() {
  const profile = Route.useLoaderData()
  const facts = profile?.facts ?? []
  const current = facts.filter((fact) => fact.valid_to === null)
  const superseded = facts.filter((fact) => fact.valid_to !== null)

  const groups = new Map<string, FactRecord[]>()
  for (const fact of current) {
    const group = groups.get(fact.fact_type) ?? []
    group.push(fact)
    groups.set(fact.fact_type, group)
  }

  return (
    <>
      <PageHeader
        description="What Reme knows about your business. Every line is a canonical fact with a source, not something it remembers you saying."
        title={profile?.org.name ?? "Business"}
      />

      {current.length === 0 ? (
        <EmptyState
          description="Prices, hours, service area and contact details land here as you tell Reme about them."
          icon={<BuildingsIcon />}
          title="Nothing recorded yet"
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {[...groups].map(([type, rows]) => (
            <Card key={type}>
              <CardHeader>
                <CardTitle>{humanise(type)}</CardTitle>
              </CardHeader>
              <CardContent>
                <DefinitionList items={rows.map(toItem)} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {superseded.length > 0 ? (
        <section aria-labelledby="history" className="mt-8">
          <h2 className="mb-1 font-medium text-lg" id="history">
            Superseded
          </h2>
          <p className="mb-3 max-w-prose text-muted-foreground text-sm">
            Facts are versioned rather than overwritten, so an answer Reme gave
            last month can still be explained.
          </p>
          <Card>
            <CardContent>
              <DefinitionList items={superseded.map(toItem)} />
            </CardContent>
          </Card>
        </section>
      ) : null}
    </>
  )
}

/** `service_area` to `Service area`, `pricing` to `Pricing`. No lookup table. */
function humanise(value: string): string {
  const words = value.replace(/_/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The last segment of a canonical key is what the owner reads. */
function label(key: string): string {
  return humanise(key.split(".").at(-1) ?? key)
}

const SOURCE: Record<FactRecord["provenance"]["source"], string> = {
  owner_stated: "You told Reme",
  document: "From a document you shared",
  integration: "From a connected account",
  inferred: "Inferred, not confirmed",
}

function toItem(fact: FactRecord): DefinitionItem {
  const verified = formatDate(fact.provenance.verified_at)
  return {
    id: fact.fact_id,
    term: label(fact.key),
    description: renderValue(fact),
    meta: [
      SOURCE[fact.provenance.source],
      `version ${fact.version}`,
      verified ? `checked ${verified}` : null,
      fact.valid_to ? `replaced ${formatDate(fact.valid_to)}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
  }
}

/**
 * A fact's value is opaque jsonb that the domain pack validates, so this reads
 * the shapes the cleaning pack uses and otherwise shows the raw value. It never
 * invents a sentence around a shape it does not recognise: an unreadable fact
 * on this screen is a fact to fix, not a fact to paper over (R8).
 */
function renderValue(fact: FactRecord): string {
  const value = fact.value as Record<string, unknown> | null
  if (!value || typeof value !== "object") {
    return String(fact.value)
  }
  if (typeof value.e164 === "string") {
    return value.e164
  }
  if (typeof value.address === "string") {
    return value.address
  }
  if (typeof value.open === "string" && typeof value.close === "string") {
    return `${value.open} to ${value.close}`
  }
  if (typeof value.centre === "string" && typeof value.radius_km === "number") {
    return `${value.centre}, within ${value.radius_km} km`
  }
  if (
    typeof value.amount_minor === "number" &&
    typeof value.currency === "string"
  ) {
    const amount = formatMoney(value.amount_minor, value.currency)
    // The unit comes from the key. Reading "an hour" onto every price would be
    // a claim the fact does not make.
    return fact.key.endsWith("_hourly") ? `${amount} an hour` : amount
  }
  return JSON.stringify(value)
}
