import { BrainIcon } from "@phosphor-icons/react"
import { createFileRoute, useRouter } from "@tanstack/react-router"
import {
  type ApprovalGrantSwitch,
  type MemoryReviewAction,
  type MemoryView,
  PROFILE_MAX_CHARS,
  type ProfileLine,
  type ProfileVersion,
  profileText,
} from "@workspace/contracts"
import { PageHeader } from "@workspace/ui/components/app-shell"
import { memoryChangeText } from "@workspace/ui/components/assistant/memory-chip"
import { Button } from "@workspace/ui/components/button"
import { Card, CardContent } from "@workspace/ui/components/card"
import { EmptyState } from "@workspace/ui/components/empty-state"
import { MemoryLines } from "@workspace/ui/components/memory-lines"
import { formatDateTime } from "@workspace/ui/lib/format"
import { GRANT_TEXT } from "@workspace/ui/lib/grants"
import { META } from "@workspace/ui/lib/utils"
import { useRef, useState } from "react"
import { getGrants, getMemory, reviewMemory, setGrant } from "@/lib/api/server"
import { assistantOf, leading } from "@/lib/briefing"
import { useLiveWorkspace } from "@/lib/workspace"
import { useBrowserZone } from "@/panel/workspace-panel"

/**
 * What the Chief of Staff remembers: about the owner, how the business runs,
 * and how they like each kind of work done, with every change. Read only:
 * the owner changes memory by telling the assistant. Business facts such as
 * prices and hours are the business page's. It also holds the owner's
 * consent settings: being asked before a save, and what runs without asking.
 */
export const Route = createFileRoute("/app/memory")({
  loader: async () => {
    const [view, grants] = await Promise.all([getMemory(), getGrants()])
    return view && { ...view, grants: grants?.grants ?? [] }
  },
  component: Memory,
})

const SOURCE: Record<ProfileLine["source"], string> = {
  owner_said: "You said it",
  owner_confirmed: "You confirmed it",
  reflection: "Learned from chat",
}

type Store = "user" | "notes" | "skills"

/** Where a change in the history was made, in the owner's terms. */
const STORE_NAME: Record<Store, string> = {
  user: "About you",
  notes: "How your business runs",
  skills: "How you like each job done",
}

/** Every store's versions as one history, newest first. */
const historyOf = (view: MemoryView) =>
  (
    [
      ["user", view.versions],
      ["notes", view.notes.versions],
      ["skills", view.skills.versions],
    ] as [Store, ProfileVersion[]][]
  )
    .flatMap(([store, versions]) => versions.map((v) => ({ store, ...v })))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))

const withSource = (lines: readonly (ProfileLine & { stale?: boolean })[]) =>
  lines.map((l) => ({ ...l, source: SOURCE[l.source] }))

function Memory() {
  const view = Route.useLoaderData()
  const router = useRouter()
  const zone = useBrowserZone()
  const { workspace } = useLiveWorkspace()
  const assistant = assistantOf(workspace)
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

  /** Runs one change, says how it went, and moves focus to the line that says so. */
  async function act(key: string | number, run: () => Promise<string>) {
    setBusy(key)
    try {
      setStatus(await run())
      await router.invalidate()
    } catch {
      setStatus("That could not be saved. Nothing was changed.")
    } finally {
      setBusy(null)
      // The button that was pressed may be gone, so focus moves to the line that says so.
      announcer.current?.focus()
    }
  }

  const answer = (action: MemoryReviewAction, done: string, key: string) =>
    act(key, async () =>
      (await reviewMemory({ data: action })) === "stale"
        ? "That suggestion is gone or no longer fits. Nothing was changed."
        : done
    )

  async function flip(change: ApprovalGrantSwitch) {
    setBusy(change.kind)
    try {
      await setGrant({ data: change })
      setStatus(
        change.on
          ? "Done. Reme won't ask first for this."
          : "Reme will ask you first again."
      )
      await router.invalidate()
    } catch {
      setStatus("That could not be saved. Nothing was changed.")
    } finally {
      setBusy(null)
    }
  }

  const history = historyOf(view)

  return (
    <>
      <PageHeader
        description={`${leading(assistant)} reads these in every chat. To change one, tell ${assistant}. Prices, hours and contact details are on the business page.`}
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

      <MemoryLines
        empty={
          <EmptyState
            description={`Tell ${assistant} how you like to work.`}
            icon={<BrainIcon />}
            title="Nothing yet"
          />
        }
        id="memory-lines"
        lines={withSource(view.lines)}
        max={PROFILE_MAX_CHARS}
        title="About you"
        used={profileText(view.lines).length}
      />

      <MemoryLines
        description="Day-to-day details the business facts don't hold, such as where the keys are kept."
        empty={<p className={`mt-1 ${META}`}>Nothing yet.</p>}
        id="memory-notes"
        lines={withSource(view.notes.lines)}
        max={view.notes.max}
        title="How your business runs"
        used={profileText(view.notes.lines).length}
      />

      {view.skills.notes.length > 0 ? (
        <section aria-labelledby="memory-skills" className="mb-8">
          <h2 className="font-semibold text-sm" id="memory-skills">
            How you like each job done
          </h2>
          <p className={`mt-1 mb-3 ${META}`}>
            Used only when {assistant} does that kind of work. A line not used
            for 60 days is marked, never removed for it.
          </p>
          {view.skills.notes.map((skill) => (
            <MemoryLines
              heading="h3"
              id={`memory-skill-${skill.name}`}
              key={skill.name}
              lines={withSource(skill.lines)}
              max={skill.max}
              title={skill.title}
              used={profileText(skill.lines).length}
            />
          ))}
        </section>
      ) : null}

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
                    : proposal.action === "remove"
                      ? `Remove "${proposal.was}"`
                      : `Change "${proposal.was}" to "${proposal.text}"`}
                  <span className={`block ${META}`}>
                    {proposal.target?.startsWith("skill:")
                      ? STORE_NAME.skills
                      : STORE_NAME[(proposal.target ?? "user") as "user"]}
                  </span>
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

      <section aria-labelledby="memory-grants" className="mb-8">
        <h2 className="font-semibold text-sm" id="memory-grants">
          Done without asking
        </h2>
        <p className={`mt-1 ${META}`}>
          Reme asks on a card before these until you tap Always allow on one, or
          switch it on here. Paying and a new phone number or email always ask.
        </p>
        <ul className="mt-2 flex flex-col">
          {view.grants.map((grant) => (
            <li key={grant.kind}>
              <label className="inline-flex min-h-8 w-fit cursor-pointer items-center gap-2 text-sm">
                <input
                  checked={grant.on}
                  className="size-4 accent-primary"
                  disabled={busy !== null}
                  onChange={(event) =>
                    void flip({
                      kind: grant.kind,
                      on: event.currentTarget.checked,
                    })
                  }
                  type="checkbox"
                />
                {GRANT_TEXT[grant.kind]}
              </label>
            </li>
          ))}
        </ul>
      </section>

      {view.corrections.length > 0 ? (
        <section aria-labelledby="memory-website" className="mb-8">
          <h2 className="font-semibold text-sm" id="memory-website">
            How your website is worked on
          </h2>
          <p className={`mt-1 ${META}`}>
            What you told your assistant about building your website, in your
            words. Every website change follows it.
          </p>
          <Card className="mt-2">
            <CardContent>
              <ul className="flex flex-col divide-y divide-border">
                {view.corrections.map((correction) => (
                  <li
                    className="wrap-break-word py-2.5 text-sm first:pt-0 last:pb-0"
                    key={correction.id}
                  >
                    {correction.text}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </section>
      ) : null}

      {history.length > 0 ? (
        <section aria-labelledby="memory-history">
          <h2 className="font-semibold text-sm" id="memory-history">
            Changes
          </h2>
          <ol className="mt-2 flex flex-col divide-y divide-border">
            {history.map((version) => {
              const when = zone ? formatDateTime(version.at, zone) : null
              return (
                <li
                  className="flex flex-col gap-0.5 py-2.5"
                  key={`${version.store}:${version.version}`}
                >
                  {version.changes.map((change) => (
                    <span
                      className="wrap-break-word text-sm"
                      key={`${change.kind}:${change.text}`}
                    >
                      {memoryChangeText(change)}
                    </span>
                  ))}
                  <span className={META}>
                    {STORE_NAME[version.store]}
                    {when ? `, ${when}` : ""}
                  </span>
                </li>
              )
            })}
          </ol>
        </section>
      ) : null}
    </>
  )
}
