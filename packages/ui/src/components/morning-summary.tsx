import {
  ArrowsClockwiseIcon,
  EnvelopeSimpleIcon,
  type Icon,
  ReceiptIcon,
  TrayArrowDownIcon,
} from "@phosphor-icons/react"
import { buttonVariants } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

const HANDLED: { icon: Icon; title: string; detail: string; time: string }[] = [
  {
    icon: EnvelopeSimpleIcon,
    title: "Enquiry answered",
    detail: "Deep clean for a three-bed semi, Saturday",
    time: "11:42 pm",
  },
  {
    icon: TrayArrowDownIcon,
    title: "New lead logged",
    detail: "Weekly office clean, from your quote form",
    time: "6:15 am",
  },
  {
    icon: ArrowsClockwiseIcon,
    title: "Quote followed up",
    detail: "Sam Patel, no reply since Monday",
    time: "8:00 am",
  },
]

/**
 * What the owner finds in the morning: the routine work already done, and the
 * one decision that waits for them.
 *
 * An illustration, not a screenshot of anyone's business, so the buttons are
 * spans and nothing here can be pressed. The caption says it is an example for
 * anyone who cannot see it.
 */
function MorningSummary({ className }: { className?: string }) {
  return (
    <figure
      className={cn(
        "w-full rounded-3xl bg-card p-2 text-card-foreground shadow-xl ring-1 ring-foreground/5 dark:ring-foreground/10",
        className
      )}
    >
      <figcaption className="sr-only">
        An example of what Reme has done by morning, and the quote it is holding
        for approval.
      </figcaption>
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <p className="font-medium text-sm">Handled overnight</p>
        <p className="text-muted-foreground text-xs">3 done</p>
      </div>
      <ul className="flex flex-col">
        {HANDLED.map((item) => (
          <li
            className="flex items-start gap-3 rounded-2xl px-4 py-3"
            key={item.title}
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
              <item.icon aria-hidden className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <p className="font-medium text-sm">{item.title}</p>
                <p className="shrink-0 text-muted-foreground text-xs tabular-nums">
                  {item.time}
                </p>
              </div>
              <p className="mt-0.5 truncate text-muted-foreground text-sm">
                {item.detail}
              </p>
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-2 rounded-2xl bg-muted p-4">
        <div className="flex items-center gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
            <ReceiptIcon aria-hidden className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-medium text-sm">Quote waiting for you</p>
            <p className="truncate text-muted-foreground text-sm">
              End of tenancy, two-bed flat, Sunday
            </p>
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="font-semibold text-2xl tabular-nums tracking-tight">
            £240
          </p>
          <div aria-hidden className="flex gap-2">
            <span
              className={buttonVariants({
                size: "sm",
                variant: "outline",
                className: "rounded-lg",
              })}
            >
              Edit
            </span>
            <span
              className={buttonVariants({
                size: "sm",
                className: "rounded-lg",
              })}
            >
              Approve
            </span>
          </div>
        </div>
        <p className="mt-3 text-muted-foreground text-xs">
          Sunday is outside your usual hours, so this one is your call.
        </p>
      </div>
    </figure>
  )
}

export { MorningSummary }
