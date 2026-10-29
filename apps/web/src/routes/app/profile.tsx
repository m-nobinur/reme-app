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
import { paletteStops } from "@workspace/ui/lib/blueprint"
import { factLabel, factText, humanise } from "@workspace/ui/lib/facts"
import { formatDate } from "@workspace/ui/lib/format"
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
        description="What your assistant knows about your business, and where each detail came from."
        title={profile?.org.name ?? "Business"}
      />

      {current.length === 0 ? (
        <EmptyState
          description="Prices, hours, service area and contact details show here as you share them."
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
            Replaced
          </h2>
          <p className="mb-3 max-w-prose text-muted-foreground text-sm">
            Older details stay here, so you can see what changed and when.
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

const SOURCE: Record<FactRecord["provenance"]["source"], string> = {
  owner_stated: "You said this",
  document: "From a document you shared",
  integration: "From a connected account",
  inferred: "Inferred, not confirmed",
}

/** The colours a stored palette shows; none when it is the owner's words alone. */
function stopsOf(value: Record<string, unknown>): string[] {
  const { id, brand, roles } = value as {
    id?: string
    brand?: string
    roles?: { paper: string; tint: string; primary: string; ink: string }
  }
  if (roles) return [roles.paper, roles.tint, roles.primary, roles.ink]
  if (brand) return paletteStops({ kind: "brand", brand })
  return id && id !== "custom"
    ? paletteStops({ kind: "preset", id } as Parameters<typeof paletteStops>[0])
    : []
}

/** A fact's value; the website's colours as a strip beside their name. */
function shownValue(fact: FactRecord) {
  const text = factText(fact.key, fact.value)
  const stops =
    fact.key === "site.palette" && fact.value && typeof fact.value === "object"
      ? stopsOf(fact.value as Record<string, unknown>)
      : []
  if (stops.length === 0) return text
  return (
    <span className="flex items-center gap-2">
      {/* The site's own colours, with a hairline so a white stop shows. */}
      <span
        aria-hidden
        className="flex h-4 w-16 shrink-0 overflow-hidden rounded-sm ring-1 ring-foreground/15"
      >
        {stops.map((color, at) => (
          <span
            className="h-full flex-1"
            // biome-ignore lint/suspicious/noArrayIndexKey: two stops may share a colour
            key={at}
            style={{ backgroundColor: color }}
          />
        ))}
      </span>
      {text}
    </span>
  )
}

function toItem(fact: FactRecord): DefinitionItem {
  const verified = formatDate(fact.provenance.verified_at)
  return {
    id: fact.fact_id,
    term: factLabel(fact.key),
    description: shownValue(fact),
    meta: [
      SOURCE[fact.provenance.source],
      verified ? `checked ${verified}` : null,
      fact.valid_to ? `replaced ${formatDate(fact.valid_to)}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
  }
}
