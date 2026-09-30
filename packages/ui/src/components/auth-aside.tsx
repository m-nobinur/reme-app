import {
  type Icon,
  MoonStarsIcon,
  ShieldCheckIcon,
  TagIcon,
} from "@phosphor-icons/react"
import { MorningSummary } from "@workspace/ui/components/morning-summary"
import { cn } from "@workspace/ui/lib/utils"
import type { ComponentProps } from "react"

/**
 * The deep surface and its three custom properties, shared with the landing
 * page so the two dark teal areas are one colour and cannot drift.
 */
const DEEP_SURFACE =
  "bg-(--ground) text-(--on) [--glow:var(--primary-foreground)] [--ground:color-mix(in_oklab,var(--primary)_55%,var(--rail-foreground))] [--on:var(--primary-foreground)] dark:[--glow:var(--primary)] dark:[--ground:color-mix(in_oklab,var(--card)_90%,var(--primary))] dark:[--on:var(--foreground)]"

const PROMISES: { icon: Icon; text: string }[] = [
  { icon: MoonStarsIcon, text: "Replies day and night" },
  { icon: TagIcon, text: "Quote requests handled" },
  { icon: ShieldCheckIcon, text: "Big calls stay yours" },
]

/**
 * The right-hand panel of every page in the sign-in flow: what the product
 * does, in one line, and what it looks like by morning.
 *
 * There is no testimonial and no customer strip, because there is nobody to
 * quote yet and a stand-in would read as real.
 *
 * The panel is a deep teal in light and the card surface in dark, so it never
 * becomes the brightest thing on a dark page. Both are set through three
 * custom properties (`--ground`, `--on`, `--glow`) rather than a `dark:`
 * variant on every class, which keeps the two themes one set of classes.
 *
 * Hidden below `lg`: on a phone the form is the page.
 */
function AuthAside({ className, ...props }: ComponentProps<"aside">) {
  return (
    <aside
      aria-label="About Reme"
      className={cn(
        DEEP_SURFACE,
        "relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-center lg:p-12 xl:p-20",
        className
      )}
      {...props}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(60% 50% at 90% 0%, color-mix(in oklch, var(--glow) 22%, transparent), transparent 70%)",
        }}
      />

      <div className="relative mx-auto flex w-full max-w-lg flex-col gap-10">
        <div>
          <h2 className="text-balance font-semibold text-4xl leading-[1.1] tracking-tight">
            Win the jobs you used to miss.
          </h2>
          <p className="mt-4 max-w-md text-(--on)/80 text-base leading-relaxed">
            Reme answers every enquiry in minutes, follows up every quote, and
            brings you only the decisions that need you.
          </p>
        </div>

        <MorningSummary />

        <ul className="grid grid-cols-3 gap-4 border-(--on)/20 border-t pt-6 text-sm">
          {PROMISES.map((item) => (
            <li className="flex flex-col gap-2" key={item.text}>
              <item.icon aria-hidden className="size-5" />
              {item.text}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  )
}

export { AuthAside, DEEP_SURFACE }
