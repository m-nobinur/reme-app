import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

/** The small grey line under a heading: a time, an expiry, a rationale. */
export const META = "text-[0.8125rem] text-muted-foreground"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
