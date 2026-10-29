import { StepMark } from "@workspace/ui/components/live-panel"
import {
  StateIcon,
  StatusIcon,
  type StatusKind,
  StatusLine,
  ToolStatus,
} from "@workspace/ui/components/status-line"
import {
  KIND_MARKS,
  STATE_MARKS,
  type StateName,
} from "@workspace/ui/lib/status-icons"
import type { ReactNode } from "react"

/**
 * Catalog entries for the status line: every kind of work while it runs, and
 * each state it can end in. All of them show at once (`delay={0}`) and pin
 * their clock, so a snapshot is a picture and not a race with the timers.
 */

type Entry = { name: string; render: () => ReactNode }

const KIND_LABELS: Record<StatusKind, string> = {
  reading: "Ellie is reading your message",
  thinking: "Ellie is thinking it through",
  still: "Ellie is still working on it",
  setup: "Setting up Spark Cleaning",
  question: "Where do you work?",
  planning: "Planning your website",
  building: "Ellie is putting your website together",
  photos: "Making 8 photos, 3 done",
  writing: "Writing the pages, 3 of 7",
  polishing: "Polishing the details",
  checking: "Checking your DNS",
  domain: "Connecting spark.example.net",
  google: "Connecting Google",
  reminder: "Setting a reminder",
  payment: "Getting the purchase ready",
  publishing: "Putting your website live",
  waiting: "Waiting for your answer",
}

const Stack = ({ children }: { children: ReactNode }) => (
  <div className="flex max-w-sm flex-col gap-3 text-sm">{children}</div>
)

/** The icon list, as the owner reads it: each mark, its name and when it is used. */
function IconList() {
  return (
    <div className="flex max-w-xl flex-col gap-6 text-sm">
      <dl className="grid grid-cols-[auto_auto_1fr] items-center gap-x-3 gap-y-2">
        {(Object.keys(STATE_MARKS) as StateName[]).map((state) => (
          <div className="contents" key={state}>
            <dt className="flex justify-center">
              <StateIcon state={state} />
            </dt>
            <dd className="font-medium">{state}</dd>
            <dd className="text-muted-foreground">{STATE_MARKS[state].use}</dd>
          </div>
        ))}
      </dl>
      <dl className="grid grid-cols-[auto_auto_1fr] items-center gap-x-3 gap-y-2">
        {(Object.keys(KIND_MARKS) as StatusKind[]).map((kind) => (
          <div className="contents" key={kind}>
            <dt className="flex justify-center text-primary">
              <StatusIcon kind={kind} still />
            </dt>
            <dd className="font-medium">{kind}</dd>
            <dd className="text-muted-foreground">{KIND_MARKS[kind].use}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

const STEP_STATES = [
  "done",
  "now",
  "waiting",
  "failed",
  "skipped",
  "next",
] as const

const statusLineCatalog: Entry[] = [
  ...(["StateIcon", "DoneIcon"] as const).map((name) => ({
    name,
    render: () => <IconList />,
  })),
  {
    // A step's mark in the panel and on the Website page, in each state.
    name: "StepMark",
    render: () => (
      <Stack>
        {STEP_STATES.map((state) => (
          <p className="flex items-center gap-2" key={state}>
            <StepMark kind="domain" state={state} />
            {state}
          </p>
        ))}
      </Stack>
    ),
  },
  // The icon alone, as the panel's rows draw it beside their own words, held
  // still; the drawn icons are the kinds that have one of their own.
  ...(
    [
      "StatusIcon",
      "ReadingIcon",
      "ThinkingIcon",
      "SetupIcon",
      "QuestionMarkIcon",
      "WorkingIcon",
      "PlanningIcon",
      "BuildingIcon",
      "PhotosIcon",
      "WritingIcon",
      "PolishingIcon",
    ] as const
  ).map((name) => ({
    name,
    render: () => (
      <Stack>
        {(Object.keys(KIND_LABELS) as StatusKind[]).map((kind) => (
          <p className="flex items-center gap-2" key={kind}>
            <StatusIcon kind={kind} still />
            {KIND_LABELS[kind]}
          </p>
        ))}
      </Stack>
    ),
  })),
  {
    // A tool's line, worded from the copy table by the tool's name.
    name: "ToolStatus",
    render: () => (
      <Stack>
        {(["working", "failed", "stopped"] as const).map((state) => (
          <ToolStatus
            announce={false}
            delay={0}
            key={state}
            state={state}
            tool="get_workspace"
          />
        ))}
      </Stack>
    ),
  },
  {
    name: "StatusLine",
    render: () => (
      <Stack>
        {(Object.keys(KIND_LABELS) as StatusKind[]).map((kind) => (
          <StatusLine
            announce={false}
            delay={0}
            key={kind}
            label={KIND_LABELS[kind]}
          />
        ))}
      </Stack>
    ),
  },
  {
    name: "StatusLine ended",
    render: () => (
      <Stack>
        <StatusLine
          announce={false}
          delay={0}
          label="Checked your DNS"
          state="done"
        />
        <StatusLine
          announce={false}
          delay={0}
          label="Couldn't reach Cloudflare, trying again"
          state="failed"
        />
        <StatusLine
          announce={false}
          delay={0}
          label="Waiting for your payment, until 11:50"
          state="waiting"
        />
        <StatusLine
          announce={false}
          delay={0}
          label="Stopped searching for a domain"
          state="stopped"
        />
      </Stack>
    ),
  },
  {
    name: "StatusLine folded and timed",
    render: () => (
      <Stack>
        <StatusLine
          announce={false}
          count={3}
          delay={0}
          label="Checking your DNS"
        />
        <StatusLine
          announce={false}
          delay={0}
          elapsed={42_000}
          label="Writing the pages"
        />
        <StatusLine
          announce={false}
          clockAfter={0}
          delay={0}
          elapsed={185_000}
          label="Planning your website"
        />
      </Stack>
    ),
  },
]

export { statusLineCatalog }
