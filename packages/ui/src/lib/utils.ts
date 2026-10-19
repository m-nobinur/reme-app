import { type ClassValue, clsx } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// The theme's own type sizes, so `text-chat` and `text-chat-step` merge as
// sizes: unknown, they read as colours and a later `text-muted-foreground`
// dropped them.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ["chat", "chat-step"] } },
})

/** The small grey line under a heading: a time, an expiry, a rationale. */
export const META = "text-[0.8125rem] text-muted-foreground"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
