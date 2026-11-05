import { PencilSimpleIcon, TrashIcon } from "@phosphor-icons/react"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Card, CardContent } from "@workspace/ui/components/card"
import { Input } from "@workspace/ui/components/input"
import { META } from "@workspace/ui/lib/utils"
import { type ReactNode, useState } from "react"

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
 * then a line each with Edit and Remove. Edit opens the line in place; Save
 * hands back the owner's own words.
 */
export function MemoryLines({
  id,
  title,
  description,
  used,
  max,
  lines,
  busy,
  empty,
  onSave,
  onRemove,
  heading: Heading = "h2",
}: {
  id: string
  title: string
  description?: string
  used: number
  max: number
  lines: readonly MemoryLine[]
  busy: boolean
  empty?: ReactNode
  onSave: (id: string, text: string) => void
  onRemove: (id: string) => void
  heading?: "h2" | "h3"
}) {
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(
    null
  )
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
                  {editing?.id === line.id ? (
                    <form
                      className="flex w-full flex-wrap items-center gap-2"
                      onSubmit={(event) => {
                        event.preventDefault()
                        onSave(line.id, editing.text)
                        setEditing(null)
                      }}
                    >
                      <Input
                        aria-label={`Edit "${line.text}"`}
                        className="min-w-0 flex-1 basis-56"
                        maxLength={300}
                        onChange={(event) =>
                          setEditing({ id: line.id, text: event.target.value })
                        }
                        value={editing.text}
                      />
                      <Button
                        disabled={busy || !editing.text.trim()}
                        size="sm"
                        type="submit"
                      >
                        Save
                      </Button>
                      <Button
                        onClick={() => setEditing(null)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <>
                      <span className="wrap-break-word min-w-0 flex-1 basis-48 text-sm">
                        {line.text}
                      </span>
                      <span className="flex flex-wrap items-center gap-2">
                        {line.stale ? (
                          <Badge variant="outline">Not used for 60 days</Badge>
                        ) : null}
                        <Badge variant="secondary">{line.source}</Badge>
                        <Button
                          aria-label={`Edit "${line.text}"`}
                          disabled={busy}
                          onClick={() =>
                            setEditing({ id: line.id, text: line.text })
                          }
                          size="icon-sm"
                          type="button"
                          variant="ghost"
                        >
                          <PencilSimpleIcon aria-hidden />
                        </Button>
                        <Button
                          aria-label={`Remove "${line.text}"`}
                          disabled={busy}
                          onClick={() => onRemove(line.id)}
                          size="icon-sm"
                          type="button"
                          variant="ghost"
                        >
                          <TrashIcon aria-hidden />
                        </Button>
                      </span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </section>
  )
}
