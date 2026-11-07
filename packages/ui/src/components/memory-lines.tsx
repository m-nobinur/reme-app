import { Badge } from "@workspace/ui/components/badge"
import { Card, CardContent } from "@workspace/ui/components/card"
import { META } from "@workspace/ui/lib/utils"
import type { ReactNode } from "react"

/** One remembered line as the page lists it. */
export type MemoryLine = {
  id: string
  text: string
  /** Where it came from, such as "You said it". */
  source: string
  /** Its skill has not loaded for 60 days: shown, never removed for it. */
  stale?: boolean
}

/**
 * One memory store as its owner reads it: a heading with how full it is,
 * then a line each with where it came from. Read only: the owner changes
 * memory by telling the assistant.
 */
export function MemoryLines({
  id,
  title,
  description,
  used,
  max,
  lines,
  empty,
  heading: Heading = "h2",
}: {
  id: string
  title: string
  description?: string
  used: number
  max: number
  lines: readonly MemoryLine[]
  empty?: ReactNode
  heading?: "h2" | "h3"
}) {
  return (
    <section aria-labelledby={id} className="mb-8">
      <Heading
        className="flex flex-wrap items-baseline gap-x-2 font-semibold text-sm"
        id={id}
      >
        {title}
        <span className="font-normal text-muted-foreground tabular-nums">
          {used.toLocaleString("en-GB")} of {max.toLocaleString("en-GB")}{" "}
          characters
        </span>
      </Heading>
      {description ? <p className={`mt-1 ${META}`}>{description}</p> : null}
      {lines.length === 0 ? (
        (empty ?? null)
      ) : (
        <Card className="mt-2">
          <CardContent>
            <ul className="flex flex-col divide-y divide-border">
              {lines.map((line) => (
                <li
                  className="flex flex-wrap items-start justify-between gap-2 py-2.5 first:pt-0 last:pb-0"
                  key={line.id}
                >
                  <span className="wrap-break-word min-w-0 flex-1 basis-48 text-sm">
                    {line.text}
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    {line.stale ? (
                      <Badge variant="outline">Not used for 60 days</Badge>
                    ) : null}
                    <Badge variant="secondary">{line.source}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </section>
  )
}
