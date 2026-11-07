import { cn } from "@workspace/ui/lib/utils"
import { useMemo } from "react"
import { encode } from "uqr"

/**
 * A QR code for `value`, drawn as one SVG path on a white tile with its quiet
 * zone, in both themes: a phone's camera reads dark on light only. `label`
 * says what scanning it does, for a screen reader.
 */
export function QrCode({
  value,
  label,
  className,
}: {
  value: string
  label: string
  className?: string
}) {
  const { d, size } = useMemo(() => {
    const code = encode(value, { ecc: "M", border: 0 })
    let modules = ""
    for (const [y, row] of code.data.entries()) {
      for (const [x, dark] of row.entries()) {
        if (dark) modules += `M${x} ${y}h1v1h-1z`
      }
    }
    return { d: modules, size: code.size }
  }, [value])
  return (
    <div
      className={cn(
        "inline-block rounded-2xl border border-border bg-brand-tile p-4 forced-color-adjust-none",
        className
      )}
      data-slot="qr-code"
    >
      <svg
        aria-label={label}
        className="block size-full text-qr-ink"
        role="img"
        shapeRendering="crispEdges"
        viewBox={`0 0 ${size} ${size}`}
      >
        <path d={d} fill="currentColor" />
      </svg>
    </div>
  )
}
