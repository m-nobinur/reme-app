import {
  AlarmIcon,
  BellIcon,
  ChatCircleDotsIcon,
  CheckCircleIcon,
  CheckIcon,
  ChecksIcon,
  CircleDashedIcon,
  CircleIcon,
  ClockIcon,
  CreditCardIcon,
  GlobeIcon,
  HourglassMediumIcon,
  type IconWeight,
  MagnifyingGlassIcon,
  MinusCircleIcon,
  type Icon as PhosphorIcon,
  PlugsConnectedIcon,
  RocketLaunchIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react"
import {
  BuildingIcon,
  type DrawnIcon,
  PhotosIcon,
  PlanningIcon,
  PolishingIcon,
  QuestionMarkIcon,
  ReadingIcon,
  SetupIcon,
  ThinkingIcon,
  WorkingIcon,
  WritingIcon,
} from "@workspace/ui/components/status-icons"
import type { StatusKind } from "@workspace/ui/lib/activity-copy"

/**
 * Every status icon the owner sees, in one list: where things stand, the
 * kinds of work, and the few things that have a picture of their own. Each
 * says when it is used. `StateIcon` and `StatusIcon` (status-line.tsx) draw
 * them, and `status-icons.test.ts` fails when a component imports one of the
 * state pictures from phosphor itself. Drawn icons are in status-icons.tsx.
 */
export type Mark = { use: string } & (
  | {
      Icon: PhosphorIcon
      weight: IconWeight
      /** The motion while it is at work (globals.css), for a kind. */
      motion?: string
    }
  | { Drawn: DrawnIcon }
)

/** A state's mark, drawn the same size and colour wherever it appears. */
export type StateMark = Mark & { size: string; colour: string }

const phosphor = (Icon: PhosphorIcon, use: string, motion?: string): Mark => ({
  Icon,
  weight: "regular",
  use,
  ...(motion ? { motion } : {}),
})

/** Where something stands, and the owner's own things. */
export const STATE_MARKS = {
  working: {
    Drawn: WorkingIcon,
    use: "Something is under way: chat lines, trays, a task in progress. Three dots folding.",
    size: "size-4",
    colour: "text-muted-foreground",
  },
  waiting: {
    Icon: ChatCircleDotsIcon,
    weight: "regular",
    use: "Waiting on the owner: an answer, an approval, a choice.",
    size: "size-4",
    colour: "text-primary",
  },
  done: {
    Icon: CheckCircleIcon,
    weight: "fill",
    use: "Finished, or picked. Also a copy button's copied state.",
    size: "size-4",
    colour: "text-primary",
  },
  failed: {
    Icon: WarningCircleIcon,
    weight: "regular",
    use: "Something broke, or an alert. The only red mark.",
    size: "size-4",
    colour: "text-destructive",
  },
  stopped: {
    Icon: MinusCircleIcon,
    weight: "regular",
    use: "Did not happen on purpose: skipped, stopped, or the owner said no.",
    size: "size-4",
    colour: "text-muted-foreground",
  },
  next: {
    Icon: CircleIcon,
    weight: "regular",
    use: "Not started yet, or a need not met.",
    size: "size-4",
    colour: "text-muted-foreground",
  },
  optional: {
    Icon: CircleDashedIcon,
    weight: "regular",
    use: "Not started, and the owner may leave it out.",
    size: "size-4",
    colour: "text-muted-foreground",
  },
  reminder: {
    Icon: AlarmIcon,
    weight: "regular",
    use: "Anything that is a reminder: the rail, Reminders, Coming up, notifications.",
    size: "size-4",
    colour: "text-muted-foreground",
  },
  time: {
    Icon: ClockIcon,
    weight: "regular",
    use: "Only beside a time, such as a reminder's due time.",
    size: "size-3.5",
    colour: "",
  },
  notifications: {
    Icon: BellIcon,
    weight: "regular",
    use: "The Notifications control and list, nothing else.",
    size: "size-4",
    colour: "",
  },
  sent: {
    Icon: CheckIcon,
    weight: "regular",
    use: "The owner's message has been sent. A delivery receipt, by the owner's decision.",
    size: "size-3",
    colour: "",
  },
  delivered: {
    Icon: ChecksIcon,
    weight: "regular",
    use: "The assistant has the owner's message.",
    size: "size-3",
    colour: "",
  },
  seen: {
    Icon: ChecksIcon,
    weight: "regular",
    use: "The assistant has started its reply.",
    size: "size-3",
    colour: "text-primary",
  },
} satisfies Record<string, StateMark>

export type StateName = keyof typeof STATE_MARKS

/**
 * One icon per kind of work, each with its own small motion while it runs.
 * The panel draws them in its segment headers and the steps at work; chat
 * draws the working dots instead. Colour comes from where it is drawn.
 */
export const KIND_MARKS: Record<StatusKind, Mark> = {
  reading: { Drawn: ReadingIcon, use: "Reading the owner's message." },
  thinking: {
    Drawn: ThinkingIcon,
    use: "Thinking, or work with no kind of its own.",
  },
  still: phosphor(
    HourglassMediumIcon,
    "Still working on it, after a long while.",
    "animate-status-turn"
  ),
  setup: { Drawn: SetupIcon, use: "Setting up the business." },
  question: { Drawn: QuestionMarkIcon, use: "An onboarding step at work." },
  planning: { Drawn: PlanningIcon, use: "Planning the website." },
  building: {
    Drawn: BuildingIcon,
    use: "Building the website, or a change to it.",
  },
  photos: { Drawn: PhotosIcon, use: "Making or reading photos." },
  writing: { Drawn: WritingIcon, use: "Writing the pages." },
  polishing: {
    Drawn: PolishingIcon,
    use: "Polishing after the design review.",
  },
  checking: phosphor(
    MagnifyingGlassIcon,
    "Checking the site or the workspace.",
    "animate-status-sweep"
  ),
  domain: phosphor(
    GlobeIcon,
    "A domain or web address.",
    "animate-status-turn"
  ),
  google: phosphor(
    PlugsConnectedIcon,
    "Connecting Google.",
    "animate-status-meet"
  ),
  reminder: phosphor(
    AlarmIcon,
    "Setting a reminder.",
    "origin-top animate-status-swing"
  ),
  payment: phosphor(
    CreditCardIcon,
    "Paying for a domain.",
    "animate-status-fade"
  ),
  publishing: phosphor(
    RocketLaunchIcon,
    "Publishing the website, or a published report.",
    "animate-status-lift"
  ),
  waiting: phosphor(
    ChatCircleDotsIcon,
    "A job waiting on the owner: a review or a question."
  ),
}
