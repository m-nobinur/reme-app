import { ArrowSquareOutIcon, GlobeIcon } from "@phosphor-icons/react"
import {
  createFileRoute,
  getRouteApi,
  Link,
  useRouter,
} from "@tanstack/react-router"
import type { BuildSummary } from "@workspace/contracts"
import { PageHeader } from "@workspace/ui/components/app-shell"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { EmptyState } from "@workspace/ui/components/empty-state"
import { StepMark, YourWebsite } from "@workspace/ui/components/live-panel"
import { SitePictures } from "@workspace/ui/components/site-pictures"
import { BuildingIcon } from "@workspace/ui/components/status-icons"
import { StatusLine } from "@workspace/ui/components/status-line"
import { workLine } from "@workspace/ui/lib/activity-copy"
import { cn } from "@workspace/ui/lib/utils"
import { useEffect, useRef, useState } from "react"
import { lastChat } from "@/chat/history"
import { SiteReadyCard } from "@/chat/site-ready"
import { getSiteMedia } from "@/lib/api/server"
import type { Workspace, WriteOutcome } from "@/lib/api/types"
import { assistantOf, leading } from "@/lib/briefing"
import { currentBuild } from "@/lib/panel"
import { anchorOf } from "@/lib/reminders"
import { readyForReview } from "@/lib/site-ready"
import {
  type CheckRow,
  checklistFor,
  type RowAction,
} from "@/lib/website-checklist"
import { useLiveWorkspace } from "@/lib/workspace"
import { photoActions, replaceLogo } from "@/panel/photo-actions"
import {
  liveThumbnail,
  useBrowserZone,
  useRequestChanges,
} from "@/panel/workspace-panel"

export const Route = createFileRoute("/app/website")({
  loader: async () => await getSiteMedia(),
  component: Website,
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

function RowActionLink({ action }: { action: RowAction }) {
  const { conversations } = frame.useLoaderData()
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
    case "google": {
      // Straight to Google's sign-in, never a line in the owner's voice.
      // Back in the owner's current conversation, where the result is said.
      const chat = lastChat(conversations)
      const back = chat ? `?returnTo=/app/c/${chat.id}` : ""
      return (
        // A document load: the route answers with a redirect to Google.
        <a className={LINK} href={`/api/google/start${back}`}>
          {action.label}
        </a>
      )
    }
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
              <StepMark kind={row.status} state={row.mark} />
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
 * The site's logo and pictures, each changed by a request like any other
 * change. A new version brings its own pictures, so they are read again
 * when the version on show changes.
 */
function Pictures({ workspace }: { workspace: Workspace }) {
  const media = Route.useLoaderData()
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const shown =
    readyForReview(workspace)?.revisionId ??
    workspace.liveRevision?.revisionId ??
    null
  const seen = useRef(shown)
  useEffect(() => {
    if (seen.current === shown) return
    seen.current = shown
    void router.invalidate({ filter: (match) => match.routeId === Route.id })
  }, [router, shown])

  const send = (write: () => Promise<WriteOutcome>) => {
    setPending(true)
    setStatus(null)
    write()
      .then((outcome) =>
        setStatus(
          outcome.done
            ? "Sent. A new version replaces this one."
            : outcome.reason
        )
      )
      .catch(() => setStatus("That did not go through. Try again."))
      .finally(() => setPending(false))
  }

  if (!media) return null
  return (
    <SitePictures
      actions={photoActions(send)}
      disabled={pending}
      logo={media.logo ? `/api/photos/${media.logo.id}` : null}
      maker={assistantOf(workspace)}
      onReplaceLogo={(file) => send(replaceLogo(file))}
      pictures={media.photos.map(({ thumbnail, ...photo }) => ({
        ...photo,
        src: thumbnail,
      }))}
      status={status}
    />
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
  const thumbnail = liveThumbnail(workspace?.liveRevision ?? null)
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
  // A version waiting on the owner, which the page shows before anything else.
  const review = readyForReview(workspace)

  if (live === null && host === null) {
    return (
      <>
        <PageHeader title="Website" />
        {review ? (
          <div className="flex flex-col gap-8">
            <SiteReadyCard />
            <Pictures workspace={workspace} />
          </div>
        ) : build ? (
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
      {review ? <SiteReadyCard className="mb-6" /> : null}
      {/* The screenshot beside the checklist once there is room for both. */}
      <div className="grid items-start gap-4 lg:grid-cols-2 lg:gap-6">
        {build ? (
          <p className="flex flex-wrap items-center gap-x-3 text-sm lg:col-span-2">
            <StatusLine
              announce={false}
              clockAfter={null}
              delay={0}
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
      <div className="mt-8">
        <Pictures workspace={workspace} />
      </div>
    </>
  )
}
