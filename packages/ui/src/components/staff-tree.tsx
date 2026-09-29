import { cn } from "@workspace/ui/lib/utils"
import type { CSSProperties } from "react"

type StaffRole = {
  name: string
  role: string
  /** A role that exists in the org tree but has not been hired yet. */
  open?: boolean
}

/**
 * One box in the picture: a name and what the role does.
 *
 * Colour comes from two custom properties, `--on` for ink and `--ground` for
 * the surface it sits on, which the parent sets. That is what lets the same
 * drawing sit on the deep teal panel and on the plain page in both themes.
 */
function StaffNode({
  name,
  role,
  lead = false,
  open = false,
}: StaffRole & { lead?: boolean }) {
  return (
    <div
      className={cn(
        "w-full rounded-2xl px-4 py-3",
        lead && "bg-(--on) text-(--ground)",
        !(lead || open) && "bg-(--on)/10 ring-(--on)/30 ring-1",
        open && "border border-(--on)/40 border-dashed"
      )}
    >
      <p className="font-medium text-sm">{name}</p>
      <p className="mt-0.5 text-xs leading-snug">{role}</p>
    </div>
  )
}

/**
 * The org tree as a figure: one lead and the roles that report to it.
 *
 * It is the same shape as the logo and as /app/staff, drawn once here so the
 * sign-in panel and the landing page cannot drift apart. The rail is one line
 * whose width is worked out from the column count, so its ends land on the
 * centre of the first and last report at any count.
 *
 * Decorative structure only; the text inside is what a reader gets, in order.
 */
function StaffTree({
  lead,
  reports,
  className,
}: {
  lead: StaffRole
  reports: StaffRole[]
  className?: string
}) {
  const count = reports.length
  return (
    <div className={cn("w-full", className)}>
      <StaffNode lead {...lead} />
      <div
        aria-hidden
        className="mx-auto hidden h-6 w-px bg-(--on)/40 md:block"
      />
      {count > 1 ? (
        <div
          aria-hidden
          className="mx-auto hidden h-px bg-(--on)/40 md:block"
          // (n - 1) column pitches out of n, where a pitch is a column plus the
          // 0.75rem gap. Both ends are then a half column in from the edges.
          style={{ width: `calc(${(count - 1) / count} * (100% + 0.75rem))` }}
        />
      ) : null}
      {/* One column below md: a row of four is too narrow to read on a phone,
          and the connectors only mean something in a row, so they go with it. */}
      <div
        className="mt-3 grid gap-3 md:mt-0 md:grid-cols-[repeat(var(--cols),minmax(0,1fr))]"
        style={{ "--cols": count } as CSSProperties}
      >
        {reports.map((report) => (
          <div className="flex flex-col items-center" key={report.name}>
            <div
              aria-hidden
              className="hidden h-6 w-px bg-(--on)/40 md:block"
            />
            <StaffNode {...report} />
          </div>
        ))}
      </div>
    </div>
  )
}

export type { StaffRole }
export { StaffTree }
