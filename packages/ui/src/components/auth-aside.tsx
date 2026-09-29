import { StaffTree } from "@workspace/ui/components/staff-tree"
import { cn } from "@workspace/ui/lib/utils"
import type { ComponentProps } from "react"

/**
 * The deep surface and its three custom properties, shared with the landing
 * page so the two dark teal areas are one colour and cannot drift.
 */
const DEEP_SURFACE =
  "bg-(--ground) text-(--on) [--glow:var(--primary-foreground)] [--ground:color-mix(in_oklab,var(--primary)_55%,var(--rail-foreground))] [--on:var(--primary-foreground)] dark:[--glow:var(--primary)] dark:[--ground:color-mix(in_oklab,var(--card)_90%,var(--primary))] dark:[--on:var(--foreground)]"

/**
 * The right-hand panel of every page in the sign-in flow.
 *
 * It shows the thing the product is built around, drawn from the same org tree
 * as the logo and as /app/staff: one point of contact, with the staff behind
 * it. There is no testimonial and no customer strip, because there is nobody
 * to quote yet and a stand-in would read as real.
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
        "relative hidden overflow-hidden lg:flex lg:flex-col lg:items-center lg:justify-center lg:gap-16 lg:p-12 xl:p-20",
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

      <div className="relative w-full max-w-lg">
        <h2 className="text-balance font-semibold text-4xl leading-[1.1] tracking-tight xl:text-5xl">
          Every enquiry gets a reply. Every big decision stays yours.
        </h2>
        <p className="mt-6 max-w-md text-base leading-relaxed">
          Reme is an AI assistant with a small team behind it. It answers your
          customers in your voice, chases quotes and keeps your website current.
          Anything involving money or a public promise waits for your approval.
        </p>
      </div>

      <StaffTree
        className="relative max-w-lg"
        lead={{ name: "Chief of Staff", role: "Your one point of contact" }}
        reports={[
          { name: "Developer", role: "Builds and updates your website" },
          {
            name: "Client Services",
            role: "Answers enquiries and prepares quotes",
          },
        ]}
      />
    </aside>
  )
}

export { AuthAside, DEEP_SURFACE }
