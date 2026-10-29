import {
  ActivityFeed,
  AGENT_NOTE,
  ApprovalRequest,
  type AssignmentState,
  type AttentionItem,
  type AvatarId,
  Blueprint,
  type BuildActivity,
  type BuildLane,
  type BuildPhoto,
  type BuildStopCause,
  type BuildSummary,
  buildFailure,
  type DerivedReminder,
  type FactRecord,
  FactValue,
  FactValueKey,
  InformationRequest,
  type OwnerTask,
  PLANNED_PAGES,
  SiteFields,
  siteHost,
  siteUrl,
  TaskKind,
  TERMINAL_STATES,
  thumbnailOf,
  WorkspaceStatus,
} from "@workspace/contracts"
import {
  approvals,
  assignments,
  currentFacts,
  domains,
  eq,
  events,
  type OrgScopedDb,
  orgs,
  reminders,
  siteRevisions,
  sql,
  type Tenancy,
  toFactRecord,
  waitedOn,
} from "@workspace/db"
import { factsToAsk } from "@workspace/gates/fields"
import { fields } from "@workspace/starter-site/site-config"
import { type OwnerWait, ownerWaits } from "@workspace/ui/lib/activity-copy"
import { activityOf, readActivityRows } from "./activity.ts"
import { sha256Hex } from "./http.ts"
import { readReminderNotes } from "./reminders.ts"

/**
 * What the owner's panel polls: attention derived from `assignments`,
 * `approvals` and `events` on every read, never stored. Every read here runs
 * inside the caller's `withOrg`, so the policy is the org filter, and each
 * one rides an index: the org's assignments, `approvals_one_open_per_revision`
 * for open approvals, `assignment_transitions_version_key` for a build's
 * latest block, the events primary key for the event that block logged,
 * `events_assignment_type_idx` for questions, answers and the feed,
 * `facts_one_current_per_key` for facts, and
 * `deployments_site_config_version_key` for the live revision.
 */

/** Parsed once per isolate, so a config the contract refuses fails at load. */
const FIELDS = SiteFields.parse(fields)

type RevisionRef = { revision_id: string; version: number }
type Report = Extract<AttentionItem, { kind: "report" }>
type Alert = Extract<AttentionItem, { kind: "alert" }>

const iso = (at: Date) => at.toISOString()

/**
 * How long each lane takes, from the click to the draft, as the bounds of
 * the range the chat and the panel both quote ("6 to 10 minutes"): p50 is
 * the low end, p95 the high. The full lane is the local runs of 2026-10-24
 * and 25 (310 to 406 s, a repair round in some; the owner's top is 10
 * minutes for a slow provider); the quick lane is 34 to 65 s to the ready card.
 * shortcut: a few runs on one machine, until EV3's rolling p50 and p95 per lane exist; swap this one object for them.
 */
export const EXPECTED_SECONDS = {
  quick: { p50: 45, p95: 90 },
  full: { p50: 360, p95: 600 },
} as const

/** What a full build is doing, finer than the stages the owner sees. */
type Step =
  | "planning"
  | "writing"
  | "assembling"
  | "design"
  | "polishing"
  | "fixing"
  | "checking"
  | "ready"

/**
 * The stages every full build lists from its first event, in the order it
 * reaches them. The photos are drawn before the pages are written, and the
 * design look and its fixes come before the gates. The activity view's
 * website segment lists the same ids.
 */
export const STAGES = [
  "planning",
  "photos",
  "writing",
  "polishing",
  "checking",
  "ready",
] as const
type Stage = (typeof STAGES)[number]

/** Where each step sits: the pages include putting them together, polish includes the look, the checks include a repair. */
const STAGE_OF: Record<Step, Stage> = {
  planning: "planning",
  writing: "writing",
  assembling: "writing",
  design: "polishing",
  polishing: "polishing",
  fixing: "checking",
  checking: "checking",
  ready: "ready",
}

const STAGE_LABEL: Record<Stage, string> = {
  planning: "Planning the layout",
  photos: "Making photos",
  writing: "Writing the pages",
  polishing: "Polishing the design",
  checking: "Checking the site",
  ready: "Ready to review",
}

/** What a stage reads while it is on the step that has a line of its own. */
const STEP_LABEL: Partial<Record<Step, string>> = {
  assembling: "Putting the site together",
  design: "Looking over the design",
}

/** Where a build waits for a person; its stage is where the events left it. */
const PARKED: readonly AssignmentState[] = [
  "blocked_on_information",
  "blocked_on_approval",
  "paused",
]

/** The states from the preview on: every stage that applied is done. */
const READY: readonly AssignmentState[] = [
  "preview_ready",
  "awaiting_review",
  "release_candidate",
  "published",
]

/**
 * An event that says where a build has got to, in the order they landed: the
 * lead's completion report, the design look's rounds (`fixes` is how many it
 * asked for, none when it did not run) and each move into `repairing`, which
 * `readBuilds` is the only one to select. The assignment state alone cannot
 * say these: the look and the lead's fix rounds both happen in `implementing`,
 * and a gate repair returns to `implementing` in the same instant.
 */
export type Mark = { type: string; fixes?: number | null }

const REPORTED = "assignment.completion_reported"
const REPAIRED = "assignment.state_changed"
/** The checks' report: its `fixes` is how many checks failed. */
const VALIDATED = "assignment.validation_reported"

/**
 * The step a build is on, or null before it starts and in a state that ends
 * it unfinished. After the lead's first report a planned build is being looked over until the look
 * answers; if it asked for changes the lead is polishing until it reports
 * again, and from that report on the build is being checked (the recheck, the
 * screenshots, then the gates). A move into `repairing` that no report has
 * followed is the lead fixing what the gates found.
 */
function stepOf(
  state: AssignmentState,
  marks: readonly Mark[],
  planned: boolean
): Step | null {
  if (state === "planning") return "planning"
  if (state === "validating") return "checking"
  if (state === "repairing") return "fixing"
  if (READY.includes(state)) return "ready"
  if (!["implementing", "revising"].includes(state)) return null
  const types = marks.map((m) => m.type)
  const reported = types.lastIndexOf(REPORTED)
  if (types.lastIndexOf(REPAIRED) > reported) return "fixing"
  if (reported < 0) return "writing"
  if (!planned) return "checking"
  const critiqued = types.indexOf("design.critiqued")
  // The look has not answered: the critic is reading the screens.
  if (critiqued < 0) return "design"
  // It asked for fixes and the lead has not reported again: the lead is making
  // them. Once it has, the recheck, the screenshots and the gates are all
  // checking, whether or not the recheck's own event has landed yet.
  return marks[critiqued]?.fixes && reported < critiqued
    ? "polishing"
    : "checking"
}

/** Counts from the parallel builder's `build.progress` events (BA4), by stage. */
export type Progress = Partial<
  Record<"pages" | "photos", { done: number; total: number }>
>

/** One `build.progress` row that names its item: a page begun or written, or a photo slot with how it settled. */
export type Settled = {
  stage: string
  item: string
  status?: string | null
  asset_id?: string | null
  /** A page whose writer has started; a row without it is a page written. */
  working?: boolean | null
}

/** The most a row counts to (the contract's bound). */
const COUNT_MAX = 999

/** The generated slots a plan still has to draw. */
const toDraw = (plan: Blueprint | null | undefined) =>
  (plan?.images ?? []).filter((i) => i.source === "generated" && !i.asset_id)

/** A quick change's three steps, in order; the orchestrator tells each as it starts it (`quick.step`). */
const QUICK_ROWS = [
  ["edit", "Writing the change"],
  ["check", "Checking the page"],
  ["preview", "Taking the preview"],
] as const

/**
 * A quick change's rows, from the step its own events last told: the ones
 * before it done, it the one `now`. Nothing is `now` before the first is
 * told; from the preview on all are done. A change the Developer makes (the
 * section lane) tells none, so its report stands for the preview.
 */
function quickActivity(
  state: AssignmentState,
  step: string | null | undefined,
  reported: boolean
): BuildActivity[] {
  const told = QUICK_ROWS.findIndex(([id]) => id === step)
  const at = READY.includes(state)
    ? QUICK_ROWS.length
    : told >= 0
      ? told
      : reported || state === "validating"
        ? QUICK_ROWS.length - 1
        : state === "queued" || state === "briefing"
          ? -1
          : 0
  return QUICK_ROWS.map(([id, label], i) => ({
    id,
    label,
    done: i < at ? 1 : 0,
    total: 1,
    ...(i === at ? { now: true as const } : {}),
  }))
}

/**
 * The same six stages for every full build from its first event, so a row
 * never appears or goes: Plan, Photos, Pages, Polish, Check, Ready. Stages
 * passed are done, the rest count what they have finished so far. A stage
 * that does not apply stays in the list as `skipped`: no photos to make, or a
 * design look that asked for no changes. The pages include putting them
 * together, polish includes the look at the design, and a repair the gates
 * sent back shows as a line under the checks until the lead reports again.
 * The stage it is on follows the build's own events (`marks`), not the state
 * alone; the pages tick as each is written, or all at once when the lead
 * reports a build it wrote itself. From the preview on every row is kept,
 * done. Any stage but the pages and photos is whole, `1 of 1`. A quick build
 * lists its own three steps instead (`quickActivity`).
 */
export function activityFor(
  lane: BuildLane,
  state: AssignmentState,
  progress: Progress = {},
  {
    plan,
    settled = [],
    marks = [],
    step,
  }: {
    plan?: Blueprint | null
    settled?: Settled[]
    marks?: Mark[]
    /** The step a quick change last told. */
    step?: string | null
  } = {}
): BuildActivity[] {
  if (lane === "quick") {
    return quickActivity(
      state,
      step,
      marks.some((m) => m.type === REPORTED)
    )
  }
  // A build waiting on a person is where its events left it: a plan, a report
  // or a counted page or photo means the lead has begun, else it is planning.
  // shortcut: an unplanned build parked before its first event reads as
  // planning, as the state alone cannot say; add the last working state to
  // the select if that shows.
  const begun =
    Boolean(plan) ||
    marks.length > 0 ||
    Boolean(progress.pages || progress.photos)
  const reached = stepOf(
    PARKED.includes(state) ? (begun ? "implementing" : "planning") : state,
    marks,
    Boolean(plan)
  )
  const queued = state === "queued" || state === "briefing"
  if (!reached && !queued) return []
  // Every page written and no report yet: the lead is putting the site
  // together, which took 2 min 20 s in perf run 2 under "6 of 6".
  const written =
    progress.pages !== undefined && progress.pages.done >= progress.pages.total
  const at: Step | null =
    reached === "writing" && plan && written ? "assembling" : reached
  const photos =
    progress.photos ??
    (toDraw(plan).length > 0
      ? { done: 0, total: toDraw(plan).length }
      : undefined)
  // The photos are drawn before the pages are written, so while slots are
  // still settling and no page has been, the photos are the stage it is on.
  const drawing =
    at === "writing" &&
    photos !== undefined &&
    photos.done < photos.total &&
    !progress.pages?.done
  const current: Stage | null = drawing ? "photos" : at && STAGE_OF[at]
  const here = current ? STAGES.indexOf(current) : -1
  const passed = (stage: Stage) => STAGES.indexOf(stage) < here
  const looked = marks.some((m) => m.type === "design.critiqued")
  const polished = marks.some((m) => m.type === "design.critiqued" && m.fixes)
  // shortcut: a build with no plan that starts counting photos after its
  // pages have begun moves back from skipped; the builder draws them first.
  const skipped: Partial<Record<Stage, boolean>> = {
    photos: !photos && (Boolean(plan) || here >= STAGES.indexOf("writing")),
    polishing: !polished && (looked || passed("polishing")),
  }
  const row = (
    id: Stage,
    count?: { done: number; total: number }
  ): BuildActivity => {
    const label =
      (at && STAGE_OF[at] === id ? STEP_LABEL[at] : undefined) ??
      STAGE_LABEL[id]
    if (skipped[id]) return { id, label, done: 0, total: 1, skipped: true }
    const total = Math.min(Math.max(count?.total ?? 1, 1), COUNT_MAX)
    // The photos keep their count while the pages are written, as the
    // builder settles slots alongside them.
    const done =
      passed(id === "photos" ? "writing" : id) ||
      (id === "ready" && at === "ready")
    return {
      id,
      label,
      done: done ? total : Math.min(count?.done ?? 0, total),
      total,
      ...(id === current && at !== "ready" ? { now: true as const } : {}),
    }
  }
  const pageRows = settled.filter((s) => s.stage === "pages")
  const pagesDone = new Set(
    pageRows.filter((s) => !s.working).map((s) => s.item)
  )
  // Begun and not written, while the writers run: several at once.
  const pagesAtWork = new Set(
    current === "writing" && !PARKED.includes(state)
      ? pageRows.filter((s) => s.working).map((s) => s.item)
      : []
  )
  const everyPage = passed("writing") || at === "assembling"
  const pages = plan?.pages.map(({ page }) => {
    const done = everyPage || pagesDone.has(page)
    return {
      label: PLANNED_PAGES.find((p) => p.id === page)?.label ?? page,
      done,
      ...(!done && pagesAtWork.has(page) ? { working: true as const } : {}),
    }
  })
  const repaired = marks.some((m) => m.type === REPAIRED)
  const found = marks.filter((m) => m.type === VALIDATED).at(-1)?.fixes
  return [
    row("planning"),
    row("photos", photos),
    { ...row("writing", progress.pages), ...(pages ? { items: pages } : {}) },
    row("polishing"),
    {
      ...row("checking"),
      ...(repaired || at === "fixing"
        ? {
            items: [
              {
                label: found
                  ? `Fixing ${found} ${found === 1 ? "thing" : "things"} the checks found`
                  : "Fixing what the checks found",
                done: at !== "fixing",
              },
            ],
          }
        : {}),
    },
    row("ready"),
  ]
}

/**
 * The photos a build is making, once its photo step has started: the slots
 * that settled, in the order they did, then those still drawing. A slot that
 * fell back has left the plan, so it has no alt.
 */
export function photosOf(
  plan: Blueprint | null | undefined,
  settled: Settled[]
): BuildPhoto[] {
  const alt = new Map((plan?.images ?? []).map((i) => [i.id, i.alt]))
  const done = new Map<string, BuildPhoto>()
  for (const s of settled) {
    if (s.stage !== "photos" || done.has(s.item)) continue
    const fell = s.status === "fallback"
    done.set(s.item, {
      slot_id: s.item,
      state: fell ? "fallback" : "made",
      alt: alt.get(s.item) ?? null,
      thumbnail: fell ? null : thumbnailOf(s.asset_id),
    })
  }
  const drawing = toDraw(plan)
    .filter((i) => !done.has(i.id))
    .map(
      (i): BuildPhoto => ({
        slot_id: i.id,
        state: "drawing",
        alt: i.alt,
        thumbnail: null,
      })
    )
  return [...done.values(), ...drawing].slice(0, 24)
}

/**
 * Site builds that have not finished, newest first, each with its latest
 * numbered revision: none until a report passes the gates, since a refused
 * one never takes a version. The panel caps the list; routing a change reads
 * all of them.
 */
export async function readBuilds(
  db: OrgScopedDb,
  limit: number | null = 10
): Promise<BuildSummary[]> {
  const query = db
    .select({
      id: assignments.id,
      kind: assignments.kind,
      state: assignments.state,
      goal: assignments.goal,
      createdAt: assignments.createdAt,
      updatedAt: assignments.updatedAt,
      // QE3 records the lane on the creation event; no row has it as a column.
      lane: sql<
        string | null
      >`(select e.payload->>'lane' from events e where e.assignment_id = assignments.id and e.type = 'assignment.created' limit 1)`,
      retryOf: sql<
        string | null
      >`(select e.payload->>'retry_of' from events e where e.assignment_id = assignments.id and e.type = 'assignment.created' limit 1)`,
      // A change's short name, which the orchestrator trims to 40 characters.
      label: sql<
        string | null
      >`(select e.payload->>'label' from events e where e.assignment_id = assignments.id and e.type = 'assignment.created' limit 1)`,
      // QE4: the quick lane handed the change on, to the Developer or on to
      // the build model. The orchestrator logs each, and the row's lane is
      // only where it started.
      // A mid-build restart, as the stall watchdog makes (the orchestrator's `retry.ts`).
      restarted: sql<boolean>`exists (select 1 from events e where e.assignment_id = assignments.id and e.type = ${AGENT_NOTE} and e.payload->>'kind' = 'resumed')`,
      fell: sql<boolean>`exists (select 1 from events e where e.assignment_id = assignments.id and (e.type = 'quick.fell_through' or (e.type = 'model.switched' and e.payload->>'reason' = 'quick.fell_through')))`,
      // Written out rather than interpolated: in a one-table select drizzle
      // drops the table name, and a bare `id` here would mean the revision's.
      revision: sql<RevisionRef | null>`(select json_build_object('revision_id', r.id, 'version', r.version) from site_revisions r where r.assignment_id = assignments.id and r.version is not null order by r.version desc limit 1)`,
      // ADR-038: the plan on the row, the round it is and the plan it
      // changed from the newest `blueprint.proposed`, by `events_assignment_type_idx`.
      blueprint: assignments.blueprint,
      proposed: sql<Record<
        string,
        unknown
      > | null>`(select e.payload from events e where e.assignment_id = assignments.id and e.type = 'blueprint.proposed' order by e.event_id desc limit 1)`,
      // BA4's counts: distinct pages or photos finished per stage, and the
      // stage's total, so a repeated event never counts twice.
      progress: sql<Progress | null>`(select json_object_agg(p.stage, json_build_object('done', p.done, 'total', p.total)) from (select e.payload->>'stage' as stage, (count(distinct e.payload->>'item') filter (where e.payload->>'working' is null))::int as done, max((e.payload->>'total')::int) as total from events e where e.assignment_id = assignments.id and e.type = 'build.progress' group by 1) p)`,
      // The same rows by name, in the order they landed: which pages are
      // written, and how each photo slot settled.
      settled: sql<
        Settled[] | null
      >`(select json_agg(json_build_object('stage', e.payload->>'stage', 'item', e.payload->>'item', 'status', e.payload->>'status', 'asset_id', e.payload->>'asset_id', 'working', (e.payload->>'working')::boolean) order by e.event_id) from events e where e.assignment_id = assignments.id and e.type = 'build.progress' and e.payload->>'item' is not null)`,
      // Where the build has got to, in order: the lead's reports, the design
      // look's rounds and each move into repairing (`activityFor`'s marks).
      marks: sql<
        Mark[] | null
      >`(select json_agg(json_build_object('type', e.type, 'fixes', case when e.type = ${VALIDATED} then (select count(*)::int from jsonb_array_elements(e.payload->'gates') g where g->>'passed' = 'false') when jsonb_typeof(e.payload->'fixes') = 'array' then jsonb_array_length(e.payload->'fixes') end) order by e.event_id) from events e where e.assignment_id = assignments.id and (e.type in ('assignment.completion_reported', 'design.critiqued', 'design.rechecked', ${VALIDATED}) or (e.type = 'assignment.state_changed' and e.payload->>'to' = 'repairing')))`,
      // The step a quick change last told (the orchestrator's `quick.step`).
      step: sql<
        string | null
      >`(select e.payload->>'step' from events e where e.assignment_id = assignments.id and e.type = 'quick.step' order by e.event_id desc limit 1)`,
      // Time the build waited on the owner's decided plan reviews: each
      // `blueprint.decided` back to the review round it answered.
      reviewMs: sql<
        number | null
      >`(select sum(extract(epoch from (d.occurred_at - p.occurred_at)) * 1000)::float8 from events d join events p on p.assignment_id = d.assignment_id and p.type = 'blueprint.proposed' and p.payload->>'review' = 'true' and p.payload->>'round' = d.payload->>'round' where d.assignment_id = assignments.id and d.type = 'blueprint.decided')`,
      // When the build last became ready to look at, in epoch milliseconds.
      readyMs: sql<
        number | null
      >`(select extract(epoch from max(e.occurred_at)) * 1000 from events e where e.assignment_id = assignments.id and e.type = 'assignment.state_changed' and e.payload->>'to' = 'preview_ready')::float8`,
    })
    .from(assignments)
    // Less a draft a change holds (the orchestrator's `holdDraft`): it is
    // paused for the change, which is the build the owner follows.
    .where(
      sql`${assignments.kind} in ('site.build', 'site.revise') and ${assignments.state} not in ${TERMINAL_STATES} and not (assignments.state = 'paused' and exists (select 1 from assignments h where h.revision_of_assignment_id = assignments.id and h.state not in ('published', 'failed', 'cancelled')))`
    )
    .orderBy(sql`${assignments.createdAt} desc`)
  const rows = await (limit === null ? query : query.limit(limit))
  return rows.map((row) => {
    const fellThrough = row.fell && row.lane === "quick"
    const lane: BuildLane =
      row.lane === "quick" && !fellThrough ? "quick" : "full"
    const plan = Blueprint.safeParse(row.blueprint).data ?? null
    const settled = row.settled ?? []
    const progress = row.progress ?? {}
    return {
      assignment_id: row.id,
      kind: row.kind as BuildSummary["kind"],
      state: row.state,
      goal: row.goal,
      ...(row.label ? { label: row.label } : {}),
      lane,
      ...(fellThrough ? { fell_through: true } : {}),
      ...(row.retryOf ? { retry: true as const } : {}),
      ...(row.restarted ? { restarted: true as const } : {}),
      activity: activityFor(lane, row.state, progress, {
        plan,
        settled,
        marks: row.marks ?? [],
        step: row.step,
      }),
      revision: row.revision,
      ...planOf(row),
      ...(progress.photos ? { photos: photosOf(plan, settled) } : {}),
      ...(row.reviewMs ? { review_ms: Math.round(row.reviewMs) } : {}),
      ...(row.readyMs ? { ready_at: new Date(row.readyMs).toISOString() } : {}),
      created_at: iso(row.createdAt),
      updated_at: iso(row.updatedAt),
    }
  })
}

/** The build's Blueprint for the panel, when it planned one that still parses. */
export function planOf(row: {
  blueprint: unknown
  proposed: Record<string, unknown> | null
}): Pick<BuildSummary, "blueprint"> {
  const plan = Blueprint.safeParse(row.blueprint)
  const round = Number(row.proposed?.round)
  if (!plan.success || !Number.isInteger(round) || round < 1) return {}
  return {
    blueprint: {
      plan: plan.data,
      round,
      previous: Blueprint.safeParse(row.proposed?.previous).data ?? null,
    },
  }
}

/** The lane one assignment was created in; `full` when none was recorded. */
export async function readLane(
  db: OrgScopedDb,
  assignmentId: string
): Promise<BuildLane> {
  const rows = await db.execute(
    sql`select payload->>'lane' as lane from events where assignment_id = ${assignmentId} and type = 'assignment.created' limit 1`
  )
  return (rows[0]?.lane as string | undefined) === "quick" ? "quick" : "full"
}

/**
 * Revision approvals the orchestrator would take a decision on now, soonest
 * expiry first: undecided, on a build awaiting review and in date, or on a
 * build the sweep parked, where a late decision still counts (ADR-032). One
 * that expired before the hourly sweep parked it is left out, since until
 * then the orchestrator refuses it.
 */
export async function readApprovals(
  db: OrgScopedDb
): Promise<Extract<AttentionItem, { kind: "approval" }>[]> {
  const rows = await db
    // A review opens only on a revision that passed the gates, which is
    // numbered by then; the filter says so to the type.
    .select({ row: approvals, version: sql<number>`${siteRevisions.version}` })
    .from(approvals)
    .innerJoin(siteRevisions, eq(siteRevisions.id, approvals.revisionId))
    .innerJoin(assignments, eq(assignments.id, approvals.assignmentId))
    .where(
      sql`${approvals.decision} is null and ${siteRevisions.version} is not null and ((${assignments.state} = 'awaiting_review' and ${approvals.expiresAt} > now()) or ${assignments.state} = 'blocked_on_approval')`
    )
    .orderBy(approvals.expiresAt)
  // The generated photos each build placed, from its newest `site.photos` event.
  const ids = rows.flatMap(({ row }) =>
    row.assignmentId ? [row.assignmentId] : []
  )
  const placed = new Map<string, NonNullable<ApprovalPhotos>>()
  if (ids.length > 0) {
    const found = await db.execute(
      sql`select distinct on (assignment_id) assignment_id, payload->'slots' as slots from events where type = 'site.photos' and assignment_id in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `
      )}) order by assignment_id, event_id desc`
    )
    for (const r of found as unknown as {
      assignment_id: string
      slots: {
        id: string
        section: string
        alt: string
        source: string
        asset_id?: string
      }[]
    }[]) {
      const photos = r.slots
        .filter((s) => s.source === "generated")
        .map((s) => {
          const thumbnail = thumbnailOf(s.asset_id)
          return {
            slot_id: s.id,
            section: s.section,
            alt: s.alt,
            ...(thumbnail ? { thumbnail } : {}),
          }
        })
      if (photos.length > 0) placed.set(r.assignment_id, photos)
    }
  }
  return rows.map(({ row, version }) => ({
    kind: "approval",
    request: ApprovalRequest.parse({
      approval_id: row.id,
      org_id: row.orgId,
      assignment_id: row.assignmentId,
      requested_by_staff_id: row.requestedByStaffId,
      approver_staff_id: row.approverStaffId,
      action_kind: row.actionKind,
      target: row.target,
      rationale: row.rationale,
      requested_at: iso(row.requestedAt),
      expires_at: iso(row.expiresAt),
    }),
    version,
    ...(row.assignmentId && placed.has(row.assignmentId)
      ? { photos: placed.get(row.assignmentId) }
      : {}),
  }))
}

type ApprovalPhotos = Extract<AttentionItem, { kind: "approval" }>["photos"]

/**
 * The question each waiting build is blocked on (`waitedOn`), open ones only,
 * oldest first, in one query. An answered question is not shown while the
 * Workflow wakes. The orchestrator's `/answer` reads the same helper and
 * refuses any other.
 */
export async function readQuestions(
  db: OrgScopedDb
): Promise<Extract<AttentionItem, { kind: "question" }>[]> {
  const waiting = await waitedOn(db, undefined, { unanswered: true })
  return waiting.map((waited) => ({
    kind: "question" as const,
    request: InformationRequest.parse(waited.request),
  }))
}

/** How many due reminders the panel lists; the rest wait on the reminders page. */
const DUE_REMINDERS_MAX = 10

/**
 * Reminders that came due and are not done, the most recently due first. One
 * stays until the owner marks it done, so a missed one is still there.
 */
export async function readDueReminders(
  db: OrgScopedDb,
  now: Date
): Promise<Extract<AttentionItem, { kind: "reminder" }>[]> {
  const rows = await db
    .select({
      id: reminders.id,
      title: reminders.title,
      dueAt: reminders.dueAt,
    })
    .from(reminders)
    .where(
      sql`${reminders.doneAt} is null and ${reminders.dueAt} <= ${iso(now)}::timestamptz`
    )
    .orderBy(sql`${reminders.dueAt} desc`)
    .limit(DUE_REMINDERS_MAX)
  return rows.flatMap((row) =>
    row.dueAt
      ? [
          {
            kind: "reminder" as const,
            reminder_id: row.id,
            title: row.title,
            due_at: iso(row.dueAt),
          },
        ]
      : []
  )
}

/**
 * Reports and alerts from the last `hours`, newest first: a publish, a
 * failed build, a build parked on its budget, a publish the probes rolled
 * back, a job that kept failing. Reached through the org's recently touched assignments, so the
 * event index is probed per build rather than the org's whole log scanned.
 */
async function readFeed(
  db: OrgScopedDb,
  hours: number,
  limit: number
): Promise<(Report | Alert)[]> {
  const [rows, paused] = await Promise.all([
    db
      .select({
        eventId: events.eventId,
        assignmentId: events.assignmentId,
        type: events.type,
        at: events.occurredAt,
        version: siteRevisions.version,
        revisionId: siteRevisions.id,
        // A failed build's reason, from its transition row by
        // `assignment_transitions_version_key`.
        failure: sql<
          string | null
        >`(select t.reason from assignment_transitions t where ${events.type} = 'assignment.state_changed' and t.assignment_id = ${events.assignmentId} and t.version = (${events.payload}->>'version')::int)`,
      })
      .from(assignments)
      .innerJoin(
        events,
        sql`${events.assignmentId} = ${assignments.id} and ${events.type} in ('deployment.activated', 'alert.raised', 'budget.exhausted', 'assignment.state_changed')`
      )
      .leftJoin(
        siteRevisions,
        sql`${siteRevisions.id} = case when ${events.type} = 'deployment.activated' then (${events.payload}->>'revision_id')::uuid end`
      )
      .where(
        sql`${assignments.updatedAt} > now() - make_interval(hours => ${hours}) and ${events.occurredAt} > now() - make_interval(hours => ${hours}) and (
        (${events.type} = 'deployment.activated' and ${events.payload}->>'kind' = 'publish')
        or (${events.type} = 'alert.raised' and ${events.payload}->>'kind' = 'publish.rolled_back')
        or ${events.type} = 'budget.exhausted'
        or (${events.type} = 'assignment.state_changed' and ${events.payload}->>'to' = 'failed'))`
      )
      .orderBy(sql`${events.eventId} desc`)
      .limit(limit),
    // A paused job belongs to no build, so the join above cannot reach it.
    db
      .select({ eventId: events.eventId, at: events.occurredAt })
      .from(events)
      .where(
        sql`${events.type} = 'alert.raised' and ${events.payload}->>'kind' = 'job.paused' and ${events.occurredAt} > now() - make_interval(hours => ${hours})`
      )
      .orderBy(sql`${events.eventId} desc`)
      .limit(limit),
  ])
  const built = rows.flatMap((row): (Report | Alert)[] => {
    const logged = {
      event_id: row.eventId,
      assignment_id: row.assignmentId,
      at: iso(row.at),
    }
    if (row.type === "deployment.activated") {
      return row.revisionId && row.version
        ? [
            {
              kind: "report",
              ...logged,
              what: "published",
              revision: { revision_id: row.revisionId, version: row.version },
            },
          ]
        : []
    }
    const reason =
      row.type === "alert.raised"
        ? "publish_rolled_back"
        : row.type === "budget.exhausted"
          ? "budget_parked"
          : "build_failed"
    return [
      {
        kind: "alert",
        ...logged,
        reason,
        ...(reason === "build_failed" ? { cause: causeOf(row.failure) } : {}),
      },
    ]
  })
  const jobs = paused.map(
    (row): Alert => ({
      kind: "alert",
      event_id: row.eventId,
      assignment_id: null,
      at: iso(row.at),
      reason: "job_paused",
    })
  )
  // Event ids are ULIDs, so the string order is the time order.
  return [...built, ...jobs]
    .sort((a, b) => (a.event_id < b.event_id ? 1 : -1))
    .slice(0, limit)
}

/** Why a build failed, in the owner's terms, from the one table the pipeline also reads. */
export const causeOf = (reason: string | null): BuildStopCause =>
  buildFailure(reason).cause

/** The org's current facts, one per key. */
export async function readFacts(db: OrgScopedDb): Promise<FactRecord[]> {
  return (await currentFacts(db)).map(toFactRecord)
}

/** Where an environment's site links point: its host suffix and, on local dev, the router's port. */
export type SiteConfig = Pick<Env, "SITE_HOST_SUFFIX" | "SITE_PORT">

/**
 * The revision the site serves now, and its host and link while it serves
 * one: the active custom domain over https when the org has one, else the
 * slug host.
 */
export async function readSite(
  db: OrgScopedDb,
  config: SiteConfig
): Promise<WorkspaceStatus["site"]> {
  const [row] = await db
    .select({
      slug: orgs.slug,
      // One site per org, and its id is the org's (ADR-031).
      live: sql<
        WorkspaceStatus["site"]["live"]
      >`(select json_build_object('revision_id', r.id, 'version', r.version, 'assignment_id', r.assignment_id) from deployments d join site_revisions r on r.id = d.revision_id where d.site_id = orgs.id order by d.config_version desc limit 1)`,
      // `activeDomainHost`'s pick, inside this statement so the poll adds none.
      custom: sql<
        string | null
      >`(select ${domains.primaryHost} from ${domains} where ${domains.state} = 'active' order by ${domains.createdAt} limit 1)`,
    })
    .from(orgs)
    .limit(1)
  const live = row?.live ?? null
  if (!row || !live) return { host: null, url: null, live }
  if (row.custom)
    return { host: row.custom, url: `https://${row.custom}`, live }
  const host = siteHost(row.slug, config.SITE_HOST_SUFFIX)
  return { host, url: siteUrl(host, config.SITE_PORT), live }
}

/** Required facts the org does not hold yet, minus the ones it keeps off the site. */
export function missingFacts(current: FactRecord[]): FactValueKey[] {
  const held = new Set(current.map((fact) => fact.key))
  return factsToAsk(FIELDS, current).ask.filter(
    (key): key is FactValueKey =>
      !held.has(key) && FactValueKey.safeParse(key).success
  )
}

/** The name the owner gave their assistant, when the fact still parses. */
export function assistantName(current: FactRecord[]): string | null {
  const held = current.find((fact) => fact.key === "assistant.name")
  const parsed =
    held && FactValue.safeParse({ key: held.key, value: held.value })
  return parsed?.success && parsed.data.key === "assistant.name"
    ? parsed.data.value.name
    : null
}

/** The face the owner picked for their assistant, or null for Reme's own. */
export function assistantAvatar(current: FactRecord[]): AvatarId | null {
  const held = current.find((fact) => fact.key === "assistant.avatar")
  const parsed =
    held && FactValue.safeParse({ key: held.key, value: held.value })
  return parsed?.success && parsed.data.key === "assistant.avatar"
    ? parsed.data.value.id
    : null
}

/** The business name fact, when it still parses. Not `factValue`: onboarding.ts reaches chat.ts, which the CoS must not (ADR-034). */
export function businessName(current: FactRecord[]): string | null {
  const held = current.find((fact) => fact.key === "business.name")
  const parsed =
    held && FactValue.safeParse({ key: held.key, value: held.value })
  return parsed?.success && parsed.data.key === "business.name"
    ? parsed.data.value.name
    : null
}

/** §7.3's order: approvals, questions, due reminders, then alerts and reports, each list as read. */
export function orderAttention(
  approvalItems: AttentionItem[],
  questions: AttentionItem[],
  feed: (Report | Alert)[],
  due: AttentionItem[] = []
): AttentionItem[] {
  return [
    ...approvalItems,
    ...questions,
    ...due,
    ...feed.filter((item) => item.kind === "alert"),
    ...feed.filter((item) => item.kind === "report"),
  ]
}

const HOUR = 3_600_000

export type ReminderInput = {
  approvals: Extract<AttentionItem, { kind: "approval" }>[]
  questions: Extract<AttentionItem, { kind: "question" }>[]
  builds: BuildSummary[]
  missing: FactValueKey[]
}

/**
 * Reminders derived from what the panel already read, so each one clears
 * when its row resolves. Order: approvals soonest to expire first, then
 * questions longest open first, then previews newest build first, then the
 * missing facts, which have no deadline.
 *
 * A preview never published is a build that has sat in `preview_ready` for
 * over 12 hours: its gates passed and the preview exists, but no review was
 * opened on it. An owner build passes through `preview_ready` for seconds on
 * its way to review, so the wait keeps the rule to builds that stopped
 * there. Opening a review moves the build to `awaiting_review` and lists its
 * approval, which this rule then leaves to `approval_expiring`; the `listed`
 * check covers a review opened between the builds and approvals reads.
 * Publishing, a cancel or a newer build superseding it takes the build out
 * of `preview_ready`.
 */
export function deriveReminders(
  input: ReminderInput,
  now: Date
): DerivedReminder[] {
  const at = now.getTime()
  const listed = new Set(
    input.approvals.map((item) => item.request.assignment_id)
  )
  return [
    ...input.approvals.flatMap(({ request, version }): DerivedReminder[] => {
      const left = Date.parse(request.expires_at) - at
      return left > 0 && left < 24 * HOUR
        ? [
            {
              rule: "approval_expiring",
              approval_id: request.approval_id,
              version,
              expires_at: request.expires_at,
            },
          ]
        : []
    }),
    ...input.questions.flatMap(({ request }): DerivedReminder[] =>
      at - Date.parse(request.requested_at) > 12 * HOUR
        ? [{ rule: "question_waiting", request_id: request.request_id }]
        : []
    ),
    ...input.builds.flatMap((build): DerivedReminder[] =>
      build.state === "preview_ready" &&
      at - Date.parse(build.updated_at) > 12 * HOUR &&
      build.revision &&
      !listed.has(build.assignment_id)
        ? [
            {
              rule: "preview_unpublished",
              assignment_id: build.assignment_id,
              version: build.revision.version,
            },
          ]
        : []
    ),
    ...(input.missing.length > 0
      ? [{ rule: "facts_missing" as const, keys: input.missing }]
      : []),
  ]
}

/** Reports and alerts stay in the panel for a day; `/activity` keeps 30. */
const PANEL_HOURS = 24

export async function readWorkspace(
  kit: Tenancy,
  orgId: string,
  config: SiteConfig,
  now = new Date()
): Promise<WorkspaceStatus> {
  return kit.withOrg({ orgId }, (db) => statusOf(db, config, now))
}

/** The workspace as one transaction sees it: `readWorkspace`'s body, and `/workspace`'s with its tag (workspace-tag.ts). */
export async function statusOf(
  db: OrgScopedDb,
  config: SiteConfig,
  now: Date
): Promise<WorkspaceStatus> {
  return (await statusWithFacts(db, config, now)).status
}

/**
 * `statusOf` with the facts it was read from, each kind's latest owner task
 * in any state, and what waits on the owner, for the assistant's view. The
 * waits are `ownerWaits`, the one list the panel, Notifications and Tasks
 * read from the same activity, so the assistant never answers "what's left"
 * with less than the owner sees.
 */
export async function statusWithFacts(
  db: OrgScopedDb,
  config: SiteConfig,
  now: Date
): Promise<{
  status: WorkspaceStatus
  facts: FactRecord[]
  tasks: OwnerTask[]
  waiting: OwnerWait[]
}> {
  // Issued together, so postgres.js pipelines them on the transaction's one
  // connection instead of paying a round trip each.
  const [
    builds,
    approvalItems,
    questions,
    feed,
    current,
    site,
    notes,
    due,
    rows,
  ] = await Promise.all([
    readBuilds(db),
    readApprovals(db),
    readQuestions(db),
    readFeed(db, PANEL_HOURS, 10),
    readFacts(db),
    readSite(db, config),
    readReminderNotes(db),
    readDueReminders(db, now),
    readActivityRows(db, now),
  ])
  const missing = missingFacts(current)
  const status = WorkspaceStatus.parse({
    site,
    builds,
    expected_seconds: EXPECTED_SECONDS,
    attention: orderAttention(approvalItems, questions, feed, due),
    missing_facts: missing,
    assistant_name: assistantName(current),
    assistant_avatar: assistantAvatar(current),
    reminders: {
      notes,
      derived: deriveReminders(
        { approvals: approvalItems, questions, builds, missing },
        now
      ),
    },
    activity: activityOf(
      {
        site,
        business: businessName(current),
        builds,
        approvals: approvalItems,
        questions,
        feed,
        due,
        notes,
        rows,
        expected: EXPECTED_SECONDS,
      },
      now
    ),
  })
  // Rows come newest first, so each kind's first is its latest, a finished
  // one included: the assistant reads the address task's end to time Google.
  const tasks = TaskKind.options.flatMap(
    (kind) => rows.tasks.find((t) => t.kind === kind) ?? []
  )
  return {
    status,
    facts: current,
    tasks,
    waiting: ownerWaits(status.activity),
  }
}

export async function readActivity(
  kit: Tenancy,
  orgId: string
): Promise<ActivityFeed> {
  const items = await kit.withOrg({ orgId }, (db) => readFeed(db, 30 * 24, 50))
  return ActivityFeed.parse({ items })
}

/**
 * A strong validator over the body itself. The body carries no clock, so an
 * unchanged workspace hashes the same on every poll, and anything that
 * changes what the owner would see changes the tag. `tail`, a message id,
 * follows a dot as it is, so the chat can read it back (`tailOf` in
 * `apps/web/src/chat/history.ts`).
 */
export async function etag(
  body: string,
  tail: string | null = null
): Promise<string> {
  const hash = (await sha256Hex(body)).slice(0, 32)
  return tail ? `"${hash}.${tail}"` : `"${hash}"`
}

/** Whether an `If-None-Match` header names this tag, weak or strong. */
export function unchanged(header: string | null, tag: string): boolean {
  if (!header) return false
  return header
    .split(",")
    .some((each) => each.trim().replace(/^W\//, "") === tag)
}
