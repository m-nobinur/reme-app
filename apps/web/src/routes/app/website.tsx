import { ArrowSquareOutIcon, GlobeIcon } from "@phosphor-icons/react"
import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router"
import type { BuildSummary } from "@workspace/contracts"
import { PageHeader } from "@workspace/ui/components/app-shell"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { EmptyState } from "@workspace/ui/components/empty-state"
import { YourWebsite } from "@workspace/ui/components/live-panel"
import { cn } from "@workspace/ui/lib/utils"
import { currentBuild } from "@/lib/panel"
import { anchorOf } from "@/lib/reminders"
import { useLiveWorkspace } from "@/lib/workspace"
import { useLiveThumbnail, useRequestChanges } from "@/panel/workspace-panel"

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

/**
 * The owner's website, read from the frame's live workspace: the address,
 * the live version and its screenshot, and Request changes, which does what
 * the panel's does.
 */
function Website() {
  const { active } = frame.useLoaderData()
  const { workspace, refresh } = useLiveWorkspace()
  const thumbnail = useLiveThumbnail(workspace?.liveRevision ?? null)
  const requestChanges = useRequestChanges()

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

  const { live, host, url, open, builds } = workspace
  const build = open ? currentBuild(builds) : undefined

  if (live === null && host === null) {
    return (
      <>
        <PageHeader title="Website" />
        {build ? (
          <EmptyState
            action={<BuildLink build={build} />}
            description="Reme is building the first version. You review it before it goes live."
            icon={<GlobeIcon />}
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
            description="Reme builds a website for your business from what you tell it in the chat. You review every version before it goes live."
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
        {host && url ? (
          <a
            className={cn(LINK, "self-start")}
            href={url}
            rel="noreferrer"
            target="_blank"
          >
            {host}
            <span className="sr-only"> (opens in a new tab)</span>
            <ArrowSquareOutIcon aria-hidden />
          </a>
        ) : null}
        {build ? (
          <p className="flex flex-wrap items-center gap-x-2 text-muted-foreground text-sm">
            {live
              ? "A change to your website is being built."
              : "Your first version is being built."}
            <BuildLink build={build} />
          </p>
        ) : null}
        {/* The screenshot and version line only: the address and Request
            changes sit above, where the page puts its actions. */}
        <YourWebsite host={null} live={live} thumbnail={thumbnail} />
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
