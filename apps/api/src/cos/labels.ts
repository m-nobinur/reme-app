import type {
  AssignmentState,
  BuildStopCause,
  CosWorkspace,
  DomainCheck,
  DomainState,
  GateName,
  TaskStepState,
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

const STEP: Record<TaskStepState, string> = {
  pending: "not started",
  in_progress: "under way",
  blocked: "waiting on the owner",
  done: "done",
  skipped: "not needed",
}

const STOPPED: Record<BuildStopCause, string> = {
  stalled: "it went quiet for too long",
  unfinished: "it could not pass its checks",
  unanswered: "it waited too long for an answer from the owner",
  service: "a service it relies on kept failing",
  other: "something went wrong on our side",
}

/** Why the pipeline started a build's Developer again mid-build. */
const RESTARTED: Record<BuildStopCause, string> = {
  stalled: "it stopped making progress",
  unfinished: "its tools kept failing",
  unanswered: "it was waiting on the owner",
  service: "a service it relies on dropped out",
  other: "something went wrong on our side",
}

/** Quiet minutes that are still work, such as the wait for the photos; past them the model hears. */
const QUIET_MINUTES = 3

const CHECK_WORDS: Record<GateName, string> = {
  build: "the site would not build",
  types: "the code checks",
  links: "broken links",
  structured_data: "the search engine data",
  content: "a claim the facts do not back",
  claims: "a claim the facts do not back",
  copy: "the wording checks",
  a11y: "the accessibility checks",
  size: "the page size",
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
    tasks,
  } = workspace
  return {
    site: { address: site.host, live: site.live_version !== null },
    builds: builds.map((b) => ({
      ref: b.assignment_id,
      kind: b.kind === "site.build" ? "new website" : "change to the website",
      state: STATE[b.state],
      lane: b.lane,
      goal: b.goal,
      ...(b.retry && { started_again_after_a_stop: true }),
      ...(b.fixing && {
        fixing: `round ${b.fixing.round} of fixing ${
          [...new Set(b.fixing.checks.map((c) => CHECK_WORDS[c]))].join(
            " and "
          ) || "what its checks found"
        }`,
      }),
      progress: (b.progress ?? []).map(
        (p) =>
          `${p.step}${p.total > 1 ? `: ${p.done} of ${p.total}` : ""}${p.now ? " (now)" : p.done >= p.total ? " (done)" : ""}`
      ),
      ...(b.timing && {
        running_minutes: b.timing.running_minutes,
        wait: b.timing.range,
        ...(b.timing.overdue && { longer_than_usual: true }),
        ...(b.timing.quiet_minutes >= QUIET_MINUTES && {
          minutes_since_last_work: b.timing.quiet_minutes,
        }),
      }),
      ...(b.restarted && {
        restarted: {
          minutes_ago: b.restarted.minutes_ago,
          why: RESTARTED[b.restarted.cause],
          working_again: b.restarted.working,
        },
      }),
    })),
    stopped_recently: (stopped ?? []).map((s) => ({
      why: STOPPED[s.cause],
      ...(s.checks?.length && {
        failed: [...new Set(s.checks.map((c) => CHECK_WORDS[c]))],
      }),
      at: s.at,
    })),
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
    // What the assistant leads over days. A blocked step's note is code's
    // words for the wait, the thing to follow up on.
    ...(tasks?.length && {
      tasks: tasks.map((t) => ({
        about: t.kind === "address" ? "the website's own address" : "Google",
        ...(t.kind === "address" && t.detail.name && { domain: t.detail.name }),
        ...(t.state === "later" && {
          put_off: true,
          ...(t.later_until && { put_off_until: t.later_until }),
        }),
        // A finished task stays in view so the next one can wait on its end.
        ...((t.state === "done" || t.state === "declined") && {
          finished: t.state,
        }),
        steps: t.steps.map(
          (s) =>
            `${s.step.replaceAll("_", " ")}: ${STEP[s.state]}${s.note ? ` (${s.note})` : ""}`
        ),
      })),
    }),
    expected_range: workspace.expected_range,
  }
}
