import { ArrowCounterClockwiseIcon, BrainIcon } from "@phosphor-icons/react"
import { createFileRoute, Link, useRouter } from "@tanstack/react-router"
import {
  type MemoryReviewAction,
  PROFILE_MAX_CHARS,
  type ProfileLine,
  profileText,
} from "@workspace/contracts"
import { PageHeader } from "@workspace/ui/components/app-shell"
import { memoryChangeText } from "@workspace/ui/components/assistant/memory-chip"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Card, CardContent } from "@workspace/ui/components/card"
import { EmptyState } from "@workspace/ui/components/empty-state"
import { formatDateTime } from "@workspace/ui/lib/format"
import { META } from "@workspace/ui/lib/utils"
import { useRef, useState } from "react"
import { getMemory, reviewMemory, undoMemory } from "@/lib/api/server"
import { useBrowserZone } from "@/panel/workspace-panel"

/**
 * What the Chief of Staff remembers of the owner: the lines it reads at the
 * start of every conversation, and every change to them, each with its undo.
 * Business facts such as prices and hours are the business page's.
 */
export const Route = createFileRoute("/app/memory")({
  loader: async () => await getMemory(),
  component: Memory,
})

const SOURCE: Record<ProfileLine["source"], string> = {
  owner_said: "You said it",
  owner_confirmed: "You confirmed it",
  reflection: "Learned from chat",
}

function Memory() {
  const view = Route.useLoaderData()
  const router = useRouter()
  const zone = useBrowserZone()
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | number | null>(null)
  const announcer = useRef<HTMLParagraphElement>(null)

  if (!view) {
    return (
      <EmptyState
        action={
          <Button onClick={() => void router.invalidate()} variant="outline">
            Try again
          </Button>
        }
        description="Your memory could not be loaded. Nothing was changed."
        icon={<BrainIcon />}
        role="alert"
        title="Something went wrong"
      />
    )
  }

  async function undo(version: number) {
    setBusy(version)
    try {
      const done = await undoMemory({ data: { version } })
      setStatus(
        done === "stale"
          ? "That change was already undone or has been edited since. Nothing was changed."
          : "Undone."
      )
      await router.invalidate()
    } catch {
      setStatus("That could not be undone. Nothing was changed.")
    } finally {
      setBusy(null)
      // The button that was pressed is gone, so focus moves to the line that says so.
      announcer.current?.focus()
    }
  }

  async function answer(
    action: MemoryReviewAction,
    done: string,
    key: string | number
  ) {
    setBusy(key)
    try {
      const out = await reviewMemory({ data: action })
      setStatus(
        out === "stale"
          ? "That suggestion is gone or no longer fits. Nothing was changed."
          : done
      )
      await router.invalidate()
    } catch {
      setStatus("That could not be saved. Nothing was changed.")
    } finally {
      setBusy(null)
      announcer.current?.focus()
    }
  }

  const used = profileText(view.lines).length

  return (
    <>
      <PageHeader
        description="What your assistant remembers about you and how you like to work. It reads these lines at the start of every conversation. Prices, hours and contact details are on the business page."
        title="Memory"
      />

      <p
        className="mb-4 text-sm outline-none empty:hidden"
        ref={announcer}
        role="status"
        tabIndex={-1}
      >
        {status}
      </p>

      <section aria-labelledby="memory-lines" className="mb-8">
        <h2
          className="flex items-baseline gap-2 font-semibold text-sm"
          id="memory-lines"
        >
          What your assistant remembers
          <span className="font-normal text-muted-foreground tabular-nums">
            {used.toLocaleString("en-GB")} of{" "}
            {PROFILE_MAX_CHARS.toLocaleString("en-GB")} characters
          </span>
        </h2>
        {view.lines.length === 0 ? (
          <EmptyState
            description="When you say how you like to work, it is saved here."
            icon={<BrainIcon />}
            title="Nothing remembered yet"
          />
        ) : (
          <Card className="mt-2">
            <CardContent>
              <ul className="flex flex-col divide-y divide-border">
                {view.lines.map((line) => (
                  <li
                    className="flex flex-wrap items-start justify-between gap-2 py-2.5 first:pt-0 last:pb-0"
                    key={line.id}
                  >
                    <span className="wrap-break-word min-w-0 flex-1 text-sm">
                      {line.text}
                    </span>
                    <Badge variant="secondary">{SOURCE[line.source]}</Badge>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </section>

      <section aria-labelledby="memory-ask" className="mb-8">
        <h2 className="font-semibold text-sm" id="memory-ask">
          Saving what your assistant learns from chat
        </h2>
        <label className="mt-2 inline-flex min-h-8 w-fit cursor-pointer items-center gap-2 text-sm">
          <input
            checked={view.ask_first}
            className="size-4 accent-primary"
            disabled={busy !== null}
            onChange={(event) =>
              void answer(
                { action: "ask_first", value: event.currentTarget.checked },
                event.currentTarget.checked
                  ? "Reme will ask before saving what it learns from chat."
                  : "Reme will save what it learns from chat and tell you.",
                "ask_first"
              )
            }
            type="checkbox"
          />
          Ask me before saving
        </label>
        {view.proposals.length > 0 ? (
          <ul className="mt-3 flex flex-col divide-y divide-border">
            {view.proposals.map((proposal) => (
              <li
                className="flex flex-wrap items-start gap-3 py-2.5"
                key={proposal.id}
              >
                <span className="wrap-break-word min-w-0 flex-1 text-sm">
                  {proposal.action === "add"
                    ? `Add "${proposal.text}"`
                    : proposal.action === "replace"
                      ? `Change "${proposal.was}" to "${proposal.text}"`
                      : `Remove "${proposal.was}"`}
                </span>
                <Button
                  disabled={busy !== null}
                  onClick={() =>
                    void answer(
                      { action: "accept", id: proposal.id },
                      "Saved.",
                      proposal.id
                    )
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Save
                </Button>
                <Button
                  disabled={busy !== null}
                  onClick={() =>
                    void answer(
                      { action: "dismiss", id: proposal.id },
                      "Dismissed.",
                      proposal.id
                    )
                  }
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Dismiss
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {view.versions.length > 0 ? (
        <section aria-labelledby="memory-history">
          <h2 className="font-semibold text-sm" id="memory-history">
            Changes
          </h2>
          <ol className="mt-2 flex flex-col divide-y divide-border">
            {view.versions.map((version) => {
              const when = zone ? formatDateTime(version.at, zone) : null
              return (
                <li
                  className="flex items-start gap-3 py-2.5"
                  key={version.version}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    {version.changes.map((change) => (
                      <span
                        className="wrap-break-word text-sm"
                        key={`${change.kind}:${change.text}`}
                      >
                        {memoryChangeText(change)}
                      </span>
                    ))}
                    <span className={META}>
                      Version {version.version}
                      {when ? `, ${when}` : ""}
                    </span>
                  </div>
                  {version.undoable ? (
                    <Button
                      aria-label={`Undo version ${version.version}`}
                      disabled={busy !== null}
                      onClick={() => void undo(version.version)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <ArrowCounterClockwiseIcon aria-hidden />
                      Undo
                    </Button>
                  ) : null}
                </li>
              )
            })}
          </ol>
        </section>
      ) : null}

      <p className={`mt-8 ${META}`}>
        Business details are kept on the{" "}
        <Link className="underline underline-offset-4" to="/app/profile">
          business page
        </Link>
        .
      </p>
    </>
  )
}
