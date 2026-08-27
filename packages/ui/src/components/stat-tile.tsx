import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import type { ComponentProps, ReactNode } from "react"

/**
 * One number on the dashboard. `hint` says what the number counts, so the
 * figure never has to be guessed from the label alone, and the digits are
 * tabular so a column of tiles does not jitter as the counts change.
 */
function StatTile({
  label,
  value,
  hint,
  ...props
}: Omit<ComponentProps<typeof Card>, "children"> & {
  label: string
  value: ReactNode
  hint?: string
}) {
  return (
    <Card size="sm" {...props}>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      {hint ? (
        <CardContent className="text-muted-foreground text-xs">
          {hint}
        </CardContent>
      ) : null}
    </Card>
  )
}

export { StatTile }
