import {
  type StatusKind,
  StatusLine,
} from "@workspace/ui/components/status-line"
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
  still: "Ellie is still on it",
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

const statusLineCatalog: Entry[] = [
  {
    name: "StatusLine",
    render: () => (
      <Stack>
        {(Object.keys(KIND_LABELS) as StatusKind[]).map((kind) => (
          <StatusLine
            announce={false}
            delay={0}
            key={kind}
            kind={kind}
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
          kind="checking"
          label="Checked your DNS"
          state="done"
        />
        <StatusLine
          announce={false}
          delay={0}
          kind="domain"
          label="Couldn't reach Cloudflare, trying again"
          state="failed"
        />
        <StatusLine
          announce={false}
          delay={0}
          kind="payment"
          label="Waiting for your payment, until 11:50"
          state="waiting"
        />
        <StatusLine
          announce={false}
          delay={0}
          kind="domain"
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
          kind="checking"
          label="Checking your DNS"
        />
        <StatusLine
          announce={false}
          delay={0}
          elapsed={42_000}
          kind="building"
          label="Writing the pages"
        />
        <StatusLine
          announce={false}
          clockAfter={0}
          delay={0}
          elapsed={185_000}
          kind="planning"
          label="Planning your website"
        />
      </Stack>
    ),
  },
]

export { statusLineCatalog }
