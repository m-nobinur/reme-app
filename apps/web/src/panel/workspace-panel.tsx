import type { DecisionRequest } from "@workspace/contracts"
import {
  ApprovalItem,
  ComingUp,
  PanelBlank,
  type Preview,
  QuestionItem,
  WaitingOnYou,
  WorkingOn,
  YourWebsite,
} from "@workspace/ui/components/live-panel"
import { useEffect, useState } from "react"
import {
  answerQuestion,
  askForChanges,
  cancelBuild,
  decideApproval,
  getPreview,
} from "@/lib/api/server"
import type { AttentionItem, Workspace, WriteOutcome } from "@/lib/api/types"
import { DECISION_REFUSED } from "@/lib/decision"
import { factLabel } from "@/lib/facts"
import { useLiveWorkspace } from "@/lib/workspace"

/**
 * The live panel, wired: the sections come from `@workspace/ui`, the reads
 * from the frame's live workspace, and every write goes through a server
 * function and then reads the workspace again, so what the panel shows is
 * always what `/workspace` last said and never a guess about what a write did.
 */

/**
 * The range a build takes, in seconds, as measured when the polling decision
 * was made (owner-workspace.md): 115 to 313 s.
 */
const TYPICAL_BUILD = { min: 115, max: 313 }

const FAILED = "That did not go through. Try again."

type Refresh = () => Promise<void>
type Approval = Extract<AttentionItem, { kind: "approval" }>
type Question = Extract<AttentionItem, { kind: "question" }>

/**
 * One write's pending and error state. The write's own refusal is shown as
 * given; a throw is a generic retry. Pending lasts until the workspace has
 * been read again, so the row does not flash back to idle before it goes.
 */
function useWrite<Name extends string>(refresh: Refresh) {
  const [pending, setPending] = useState<Name | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async (name: Name, write: () => Promise<WriteOutcome>) => {
    setPending(name)
    setError(null)
    try {
      const outcome = await write()
      if (!outcome.done) {
        setError(outcome.reason)
        return false
      }
      await refresh()
      return true
    } catch {
      setError(FAILED)
      return false
    } finally {
      setPending(null)
    }
  }
  return { pending, error, run }
}

function Answerable({ item, refresh }: { item: Question; refresh: Refresh }) {
  const { pending, error, run } = useWrite<"answer">(refresh)
  return (
    <QuestionItem
      askedBy={item.raisedBy}
      error={error}
      expiresAt={item.expiresAt}
      onAnswer={(value) =>
        void run("answer", () =>
          answerQuestion({
            data: {
              assignmentId: item.assignmentId,
              requestId: item.id,
              value,
              key: crypto.randomUUID(),
            },
          })
        )
      }
      onExpiry={item.onExpiry}
      pending={pending !== null}
      spec={item.answer}
      title={item.title}
      why={item.detail}
    />
  )
}

/** The preview of the build behind an approval, read when the row mounts. */
function usePreview(
  assignmentId: string | null
): Preview | "loading" | "error" {
  const [preview, setPreview] = useState<Preview | "loading" | "error">(
    "loading"
  )
  useEffect(() => {
    if (!assignmentId) {
      setPreview("error")
      return
    }
    let current = true
    getPreview({ data: { assignmentId } }).then(
      (link) => current && setPreview(link ?? "error"),
      () => current && setPreview("error")
    )
    return () => {
      current = false
    }
  }, [assignmentId])
  return preview
}

function Decidable({
  item,
  refresh,
  announce,
}: {
  item: Approval
  refresh: Refresh
  announce: (status: string) => void
}) {
  const { pending, error, run } = useWrite<"approve" | "change">(refresh)
  const preview = usePreview(item.request.assignment_id)

  const approve = (decision: DecisionRequest) =>
    void run("approve", async () => {
      const outcome = await decideApproval({
        data: {
          approvalId: item.request.approval_id,
          revisionId: decision.revision_id,
          decision: decision.decision,
        },
      })
      if (!outcome.recorded) {
        return { done: false, reason: DECISION_REFUSED[outcome.reason] }
      }
      announce(`Approved v${item.version}. It is being published.`)
      return { done: true }
    })

  const change = (text: string) =>
    void run("change", async () => {
      const outcome = await askForChanges({
        data: { text, key: crypto.randomUUID() },
      })
      if (outcome.done) {
        announce(`Sent. A new version replaces v${item.version}.`)
      }
      return outcome
    })

  return (
    <ApprovalItem
      error={error}
      expiresAt={item.request.expires_at}
      onApprove={approve}
      onAskForChanges={change}
      onExpiry={item.onExpiry}
      pending={pending}
      preview={preview}
      rationale={item.detail}
      target={item.request.target}
      version={item.version}
    />
  )
}

/** The first steps an empty workspace still needs, from its own rows. */
const firstSteps = (workspace: Workspace) => [
  ...workspace.missingFacts.map((key) => ({
    label: factLabel(key),
    done: false,
  })),
  { label: "Build your first version", done: false },
]

/** What closes next: reviews and questions with an expiry, soonest first. */
function comingUp(attention: AttentionItem[]) {
  return attention
    .flatMap((item) =>
      item.expiresAt
        ? [
            {
              id: item.id,
              at: item.expiresAt,
              text:
                item.kind === "approval"
                  ? `Your review of version ${item.version} closes`
                  : `The question about ${item.title.toLowerCase()} closes`,
            },
          ]
        : []
    )
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

export function WorkspacePanel() {
  const { workspace, failed, refresh } = useLiveWorkspace()
  const [status, setStatus] = useState<string | null>(null)
  const stop = useWrite<"stop">(refresh)
  const stale = failed
    ? "This panel did not refresh. It tries again in a minute."
    : null

  if (!workspace) {
    return <WaitingOnYou error={stale ?? "This panel did not load."} />
  }
  const { attention, builds, live, host } = workspace
  if (!live && builds.length === 0 && attention.length === 0) {
    return <PanelBlank steps={firstSteps(workspace)} />
  }

  const current =
    builds.find((build) => build.state !== "queued") ?? builds.at(-1)
  const queued = builds
    .filter((build) => build !== current && build.state === "queued")
    .map((build) => build.goal)

  return (
    <>
      {current ? (
        <WorkingOn
          build={{
            goal: current.goal,
            state: current.state,
            version: current.revision?.version ?? null,
            startedAt: current.created_at,
          }}
          error={stop.error}
          key={current.assignment_id}
          onStop={() =>
            void stop.run("stop", () =>
              cancelBuild({ data: { assignmentId: current.assignment_id } })
            )
          }
          queued={queued}
          stopping={stop.pending !== null}
          typical={TYPICAL_BUILD}
        />
      ) : null}
      <WaitingOnYou error={stale} status={status}>
        {attention.map((item) =>
          item.kind === "approval" ? (
            <Decidable
              announce={setStatus}
              item={item}
              key={item.id}
              refresh={refresh}
            />
          ) : item.kind === "question" ? (
            <Answerable item={item} key={item.id} refresh={refresh} />
          ) : null
        )}
      </WaitingOnYou>
      <ComingUp items={comingUp(attention)} />
      {live || host ? <YourWebsite host={host} live={live} /> : null}
    </>
  )
}
