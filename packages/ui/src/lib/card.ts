/**
 * The surface a card that waits on the owner sits on in the transcript: an
 * approval, a plan, the site that is ready. Onboarding's questions sit in the
 * question tray instead. One radius, border and padding, so they read as one set; the
 * width and the space around each stay with the card.
 */
export const CARD_SURFACE =
  "rounded-3xl border border-border bg-card p-4 text-card-foreground"

/** A pill or tile the owner picks inside a card or the tray, as a native radio or checkbox under it. */
export const OPTION =
  "relative flex cursor-pointer border border-border bg-card text-card-foreground transition-colors duration-150 hover:border-primary/50 has-[:focus-visible]:border-ring has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring has-[:checked]:border-primary has-[:checked]:bg-primary/5"

/** An option as a pill, for a short label. */
export const OPTION_PILL = "min-h-9 items-center rounded-full px-4 text-sm"

/** An option as a tile, for one with a hint or a picture. */
export const OPTION_TILE = "flex-col gap-2 rounded-2xl p-3"

/** The line under a field that says what is wrong with it. */
export const FIELD_ERROR = "text-[0.8125rem] text-destructive"
