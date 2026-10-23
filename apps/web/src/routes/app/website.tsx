import {
  ArrowSquareOutIcon,
  ChatCircleDotsIcon,
  CheckCircleIcon,
  CircleIcon,
  GlobeIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react"
import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router"
import type { BuildSummary } from "@workspace/contracts"
import { PageHeader } from "@workspace/ui/components/app-shell"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { EmptyState } from "@workspace/ui/components/empty-state"
import { YourWebsite } from "@workspace/ui/components/live-panel"
import { BuildingIcon } from "@workspace/ui/components/status-icons"
import { StatusIcon, StatusLine } from "@workspace/ui/components/status-line"
import { segmentKind, workLine } from "@workspace/ui/lib/activity-copy"
import { cn } from "@workspace/ui/lib/utils"
import { assistantOf, leading } from "@/lib/briefing"
import { currentBuild } from "@/lib/panel"
import { anchorOf } from "@/lib/reminders"
import {
  type CheckRow,
  checklistFor,
  type RowAction,
} from "@/lib/website-checklist"
import { useLiveWorkspace } from "@/lib/workspace"
import {
  useBrowserZone,
  useLiveThumbnail,
  useRequestChanges,
} from "@/panel/workspace-panel"

export const Route = createFileRoute("/app/website")({
  component: WebsitePage,
})

const frame = getRouteApi("/app")

// No side padding, so the link lines up with the text around it.
const LINK = cn(buttonVariants({ variant: "link" }), "px-0")

/** Opens the panel on the build, and stays on this page. */
function BuildLink({ build }: { build: BuildSummary }) {
  const focus = anchorOf.build(build.assignment_id)
  return (
    <Link
      className={LINK}
      replace
      state={() => ({ panel: { key: crypto.randomUUID(), focus } })}
      to="."
    >
      See the build
    </Link>
  )
}

/** The mark the panel's steps use for the same state. */
function RowMark({ row }: { row: CheckRow }) {
  switch (row.mark) {
    case "done":
      return <CheckCircleIcon className="size-4 text-primary" weight="fill" />
    case "now":
      return <StatusIcon className="text-primary" kind={row.status} />
    case "waiting":
      return (
        <ChatCircleDotsIcon className="size-4 animate-status-fade text-primary motion-reduce:animate-none" />
      )
    case "failed":
      return <WarningCircleIcon className="size-4 text-destructive" />
    default:
      return <CircleIcon className="size-4 text-muted-foreground/60" />
  }
}

function RowActionLink({ action }: { action: RowAction }) {
  switch (action.kind) {
    case "visit":
      return (
        <a className={LINK} href={action.href} rel="noreferrer" target="_blank">
          {action.label}
          <span className="sr-only"> (opens in a new tab)</span>
          <ArrowSquareOutIcon aria-hidden />
        </a>
      )
    case "review":
      return (
        <Link className={LINK} to="/app/approvals">
          {action.label}
        </Link>
      )
    case "ask":
      return (
        <Link
          className={LINK}
          state={() => ({ chat: crypto.randomUUID(), ask: action.ask })}
          to="/app"
        >
          {action.label}
        </Link>
      )
  }
}

/** Where the site stands: published, its address and Google, each with its next action. */
function Checklist({ rows }: { rows: CheckRow[] }) {
  return (
    <section aria-labelledby="standing" className="flex flex-col gap-1">
      <h2 className="font-medium text-sm" id="standing">
        Where things stand
      </h2>
      <ul className="flex flex-col divide-y divide-border">
        {rows.map((row) => (
          <li className="flex items-start gap-2.5 py-3" key={row.id}>
            <span aria-hidden className="mt-0.5 flex size-4 shrink-0">
              <RowMark row={row} />
            </span>
            <div className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3">
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm">{row.title}</span>
                <span
                  className={cn(
                    "text-[0.8125rem] text-muted-foreground",
                    row.mark === "now" &&
                      "shimmer shimmer-color-foreground motion-reduce:animate-none"
                  )}
                >
                  {row.line}
                </span>
              </div>
              {row.action ? <RowActionLink action={row.action} /> : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * The owner's website, read from the frame's live workspace: its screenshot,
 * Request changes, which does what the panel's does, and the rows of where
 * the site stands, read from the same activity as the panel.
 */
function Website() {
  const { active } = frame.useLoaderData()
  const { workspace, refresh } = useLiveWorkspace()
  const thumbnail = useLiveThumbnail(workspace?.liveRevision ?? null)
  const requestChanges = useRequestChanges()
  const zone = useBrowserZone()

  if (!workspace) {
    return (
      <EmptyState
        action={
          <Button onClick={() => void refresh()} variant="outline">
            Try again
          </Button>
        }
        description="Your website could not be loaded. Nothing was changed."
        icon={<GlobeIcon />}
        role="alert"
        title="Something went wrong"
      />
    )
  }

  const { live, host, open, builds } = workspace
  const build = open ? currentBuild(builds) : undefined
  // The segment doing the work, whose step the page says: the first
  // website's, or a change's.
  const work = [
    ...(workspace.activity?.journey ?? []),
    ...(workspace.activity?.now ?? []),
  ].find((s) => s.kind === "website" || s.kind === "change")
  const step = work ? workLine(work) : null

  if (live === null && host === null) {
    return (
      <>
        <PageHeader title="Website" />
        {build ? (
          <EmptyState
            description={
              step
                ? `${step}. You review it before it goes live.`
                : `${leading(assistantOf(workspace))} is building the first version. You review it before it goes live.`
            }
            icon={<BuildingIcon animated className="text-primary" />}
            title="Your website is under way"
          />
        ) : (
          <EmptyState
            action={
              active ? (
                <Link
                  className={buttonVariants()}
                  state={() => ({
                    chat: crypto.randomUUID(),
                    ask: "Build my website",
                  })}
                  to="/app"
                >
                  Create my website
                </Link>
              ) : (
                <Link className={buttonVariants()} to="/name-your-business">
                  Name your business
                </Link>
              )
            }
            description={`${leading(assistantOf(workspace))} builds a website for your business from what you share in the chat. You review every version before it goes live.`}
            icon={<GlobeIcon />}
            title={
              active ? `${active.name} has no website yet` : "No website yet"
            }
          />
        )}
      </>
    )
  }

  return (
    <>
      <PageHeader
        actions={
          live ? (
            <Button onClick={requestChanges}>Request changes</Button>
          ) : null
        }
        description="What your customers see, and where to ask for a change."
        title="Website"
      />
      <div className="flex max-w-xl flex-col gap-4">
        {build ? (
          <p className="flex flex-wrap items-center gap-x-3 text-sm">
            <StatusLine
              announce={false}
              clockAfter={null}
              delay={0}
              kind={work ? segmentKind(work) : "building"}
              label={
                step ??
                (live
                  ? "A change to your website is being built"
                  : "Your first version is being built")
              }
              state={work?.state === "waiting" ? "waiting" : "working"}
            />
            <BuildLink build={build} />
          </p>
        ) : null}
        {/* The screenshot and version line only: the address and Request
            changes sit above, where the page puts its actions. */}
        <YourWebsite host={null} live={live} thumbnail={thumbnail} />
        <Checklist rows={checklistFor(workspace, zone, new Date())} />
      </div>
    </>
  )
}

/**
 * The page keeps to the composer's width and the left edge every page title
 * shares, so its actions stay clear of the panel floating at the top right.
 */
function WebsitePage() {
  return (
    <div className="max-w-2xl">
      <Website />
    </div>
  )
}
