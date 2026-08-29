import type { UIMessageChunk } from "ai"

/**
 * One recorded Chief of Staff turn, as the AI SDK v7 UI message chunks a live
 * model run would have emitted. It is the fixture the chat surface is built
 * against until the real runtime lands: same wire format, same part types, same
 * order, so swapping in a live endpoint changes the route and nothing else.
 *
 * It names no business. Reporting a fixture organisation's week to whoever is
 * signed in is the defect that failed exit gate 9 on the staff directory: a
 * screen about someone else's business reads as a cross-tenant leak. The
 * figures are still invented, so the turn opens by saying so.
 */

/** Milliseconds between chunks, so a replay streams rather than arrives. */
const TEXT_DELAY = 18
const STEP_DELAY = 260

type RecordedChunk = { delayMs: number; chunk: UIMessageChunk }

const text = (id: string, body: string): RecordedChunk[] => [
  { delayMs: STEP_DELAY, chunk: { type: "text-start", id } },
  ...body.split(/(?<=\s)/).map((delta) => ({
    delayMs: TEXT_DELAY,
    chunk: { type: "text-delta" as const, id, delta },
  })),
  { delayMs: TEXT_DELAY, chunk: { type: "text-end", id } },
]

const reasoning = (id: string, body: string): RecordedChunk[] => [
  { delayMs: STEP_DELAY, chunk: { type: "reasoning-start", id } },
  ...body.split(/(?<=\s)/).map((delta) => ({
    delayMs: TEXT_DELAY,
    chunk: { type: "reasoning-delta" as const, id, delta },
  })),
  { delayMs: TEXT_DELAY, chunk: { type: "reasoning-end", id } },
]

const REVIEW_TOOL_CALL = "call_read_week"
const PUBLISH_TOOL_CALL = "call_publish_revision"
const APPROVAL_ID = "approval_publish_revision"

/**
 * The immutable target the approval is bound to. §7.3 requires one. No org key:
 * the tenant is the session's, never a field in the payload (R3). The hostname
 * is the one RFC 2606 reserves, so it can never be a tenant's own; anything
 * under `remeai.co.uk` sits in the `{slug}` namespace ADR-030 hands out.
 */
const PUBLISH_INPUT = {
  revision: "rev_2f41c9",
  domain: "example.com",
  changes: 3,
}

/** Streams until the approval request, then stops and waits for the owner. */
const OPENING: RecordedChunk[] = [
  { delayMs: 0, chunk: { type: "start" } },
  { delayMs: 0, chunk: { type: "start-step" } },
  ...reasoning(
    "reasoning_week",
    "Three assignments closed this week and one is waiting on a decision. The site revision is the only thing blocked on the owner, so it goes last and everything else is a summary."
  ),
  {
    delayMs: STEP_DELAY,
    chunk: {
      type: "tool-input-start",
      toolCallId: REVIEW_TOOL_CALL,
      toolName: "read_week",
    },
  },
  {
    delayMs: 120,
    chunk: {
      type: "tool-input-available",
      toolCallId: REVIEW_TOOL_CALL,
      toolName: "read_week",
      input: { window: "last_7_days" },
    },
  },
  {
    delayMs: 900,
    chunk: {
      type: "tool-output-available",
      toolCallId: REVIEW_TOOL_CALL,
      output: {
        assignmentsClosed: 3,
        enquiriesAnswered: 11,
        blocked: ["site revision rev_2f41c9 awaiting approval"],
      },
    },
  },
  ...text(
    "text_report",
    `This is a preview of how I report, on made-up numbers. I am not reading your business yet.

- Three assignments closed, including the two quote follow-ups you asked me to chase.
- Eleven enquiries answered, all within the hour.
- One thing is waiting on you.

I have a site revision ready. It corrects the service-area list and the two opening hours you changed on Tuesday.`
  ),
  {
    delayMs: STEP_DELAY,
    chunk: {
      type: "tool-input-start",
      toolCallId: PUBLISH_TOOL_CALL,
      toolName: "publish_revision",
    },
  },
  {
    delayMs: 120,
    chunk: {
      type: "tool-input-available",
      toolCallId: PUBLISH_TOOL_CALL,
      toolName: "publish_revision",
      input: PUBLISH_INPUT,
    },
  },
  {
    delayMs: 200,
    chunk: {
      type: "tool-approval-request",
      approvalId: APPROVAL_ID,
      toolCallId: PUBLISH_TOOL_CALL,
      reason: "Publishing a revision changes what visitors see.",
    },
  },
  { delayMs: 0, chunk: { type: "finish-step" } },
  { delayMs: 0, chunk: { type: "finish" } },
]

/** What the recording does once the owner approves. */
const APPROVED: RecordedChunk[] = [
  { delayMs: 0, chunk: { type: "start" } },
  { delayMs: 0, chunk: { type: "start-step" } },
  {
    delayMs: 900,
    chunk: {
      type: "tool-output-available",
      toolCallId: PUBLISH_TOOL_CALL,
      output: {
        published: true,
        revision: PUBLISH_INPUT.revision,
        url: `https://${PUBLISH_INPUT.domain}`,
      },
    },
  },
  ...text(
    "text_published",
    `Published. ${PUBLISH_INPUT.domain} is serving revision ${PUBLISH_INPUT.revision}, and the previous one stays available for a rollback.`
  ),
  { delayMs: 0, chunk: { type: "finish-step" } },
  { delayMs: 0, chunk: { type: "finish" } },
]

/** What the recording does once the owner declines. */
const DENIED: RecordedChunk[] = [
  { delayMs: 0, chunk: { type: "start" } },
  { delayMs: 0, chunk: { type: "start-step" } },
  {
    delayMs: 400,
    chunk: { type: "tool-output-denied", toolCallId: PUBLISH_TOOL_CALL },
  },
  ...text(
    "text_held",
    `Left unpublished. ${PUBLISH_INPUT.revision} stays in preview and I will not raise it again unless you ask.`
  ),
  { delayMs: 0, chunk: { type: "finish-step" } },
  { delayMs: 0, chunk: { type: "finish" } },
]

export { APPROVED, DENIED, OPENING, type RecordedChunk }
