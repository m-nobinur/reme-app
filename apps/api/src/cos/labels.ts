import type {
  AssignmentState,
  BuildStopCause,
  CosWorkspace,
  DomainCheck,
  DomainState,
} from "@workspace/contracts"

// The workspace as the model reads it each turn: labels in the owner's
// words, never an id, a version number or a raw value. What a tool must be
// given back sits in a field named `ref`, which the instructions say is
// never said to the owner.

const STATE: Record<AssignmentState, string> = {
  queued: "waiting its turn",
  briefing: "being planned",
  planning: "being planned",
  implementing: "being built",
  validating: "being checked",
  preview_ready: "ready for the owner to look over",
  awaiting_review: "ready for the owner to look over",
  revising: "being revised",
  release_candidate: "ready to publish",
  published: "published",
  blocked_on_information: "waiting on an answer from the owner",
  blocked_on_approval: "waiting on the owner's approval",
  repairing: "being fixed",
  paused: "paused",
  failed: "failed",
  cancelled: "cancelled",
}

const DOMAIN: Record<DomainState, string> = {
  awaiting_payment: "waiting for payment",
  awaiting_dns: "waiting for the owner to add the records",
  verifying: "being checked",
  active: "connected",
  failed: "failed",
  abandoned: "given up on",
  removed: "removed",
}

const CHECK: Record<DomainCheck["status"], string> = {
  not_found: "records not found yet",
  unknown_error: "could not be checked",
  conflicting_record: "a conflicting record is in the way",
  pending_verification: "waiting for verification",
  invalid_configuration: "set up wrongly",
  pending_certificate: "waiting for the secure certificate",
  valid: "working",
}

const STOPPED: Record<BuildStopCause, string> = {
  stalled: "it went quiet for too long",
  unfinished: "it could not pass its checks",
  unanswered: "it waited too long for an answer from the owner",
  service: "a service it relies on kept failing",
  other: "something went wrong on our side",
}

/** `owner.preferred_name` as `owner preferred name`. */
const plain = (key: string) => key.replace(/[._]/g, " ")

export function workspaceLabels(workspace: CosWorkspace) {
  const {
    site,
    builds,
    stopped,
    questions,
    approvals,
    missing_facts,
    domains,
  } = workspace
  return {
    site: { address: site.host, live: site.live_version !== null },
    builds: builds.map((b) => ({
      ref: b.assignment_id,
      kind: b.kind === "site.build" ? "new website" : "change to the website",
      state: STATE[b.state],
      lane: b.lane,
      goal: b.goal,
      progress: b.progress.map(
        (p) =>
          `${p.step}${p.total > 1 ? `: ${p.done} of ${p.total}` : ""}${p.now ? " (now)" : p.done >= p.total ? " (done)" : ""}`
      ),
    })),
    stopped_recently: stopped.map((s) => ({ why: STOPPED[s.cause], at: s.at })),
    questions: questions.map((q) => ({
      ref: { request_id: q.request_id, field: q.field },
      about: plain(q.field),
      why: q.why,
      options: q.options,
      blocking: q.blocking,
    })),
    reviews_waiting: approvals.map((a) => ({ expires_at: a.expires_at })),
    missing_facts: missing_facts.map(plain),
    ...(domains && {
      domains: domains.map((d) => ({
        name: d.name,
        state: DOMAIN[d.state],
        last_check: d.last_check && CHECK[d.last_check.status],
      })),
    }),
    expected_seconds: workspace.expected_seconds,
  }
}
