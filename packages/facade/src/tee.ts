import type { FlueObservation } from "@flue/runtime"
import type { EventEnvelope, TaintLabel } from "@workspace/contracts"
import { monotonicFactory } from "ulid"

// A package may import only contracts, config and observability, so the facade
// cannot reach `newUlid` in `@workspace/db` and keeps its own monotonic
// factory: a Worker's clock stands still within a request, and plain `ulid()`
// would order same-millisecond ids at random, while `event_id` is the append
// order. Marked pure so a Worker that never tees drops it and `ulid`.
const ulid = /* @__PURE__ */ monotonicFactory()

/**
 * The longest one sink call may take. Flushes run one after another, so a
 * write that never settles (a Durable Object request cut off mid-query,
 * measured locally 2026-10-25) held every later event back, and the
 * Developer's `report_complete`, which awaits a flush, never woke its
 * Workflow. Past this the call counts as failed and the next flush retries.
 */
export const SINK_TIMEOUT_MS = 15_000

function bounded<T>(call: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("event sink timed out")),
      SINK_TIMEOUT_MS
    )
  })
  return Promise.race([call, late]).finally(() => clearTimeout(timer))
}

/**
 * The write path the facade is handed (architect ruling 2). Two operations
 * and no more: the last seq a session holds, and an append of rows that
 * must be contiguous with it. `apps/orchestrator` implements it over
 * `withOrg`; the facade never sees a database.
 */
export type EventSink = {
  lastSeq: (sessionId: string) => Promise<number | null>
  append: (rows: EventEnvelope[]) => Promise<void>
}

export type TeeIds = {
  org_id: string
  staff_id: string | null
  assignment_id: string
  session_id: string
}

export type Tee = {
  /** Register with flue's `observe()`. */
  subscriber: (observation: FlueObservation) => void
  /** A facade-owned event in the same stream, in order with the runtime's. */
  emit: (
    type: string,
    payload: Record<string, unknown>,
    taint?: TaintLabel[]
  ) => void
  /** Resolves when everything emitted so far has been appended. */
  flush: () => Promise<void>
}

type Pending = Omit<EventEnvelope, "seq">

const SECRET_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /postgres(ql)?:\/\/[^\s"']+/g,
]

/**
 * Nothing model-visible is dropped except what is not model-visible: the
 * `turn_request` body is the prompt, the messages and the tool list, all of
 * which the log already holds as their own events, and it is the one event
 * that could carry a key in a header. Strings that look like a key are
 * replaced wherever they sit. Deep-cloned through JSON, which also drops
 * anything a row cannot hold.
 */
export function redact(observation: FlueObservation): Record<string, unknown> {
  const clone = JSON.parse(
    JSON.stringify(observation, (_key, value) =>
      typeof value === "string" ? scrub(value) : value
    )
  ) as Record<string, unknown>
  if (clone.type === "turn_request") {
    const request = clone.request as Record<string, unknown> | undefined
    const input = request?.input as
      | { systemPrompt?: string; messages?: unknown[]; tools?: unknown[] }
      | undefined
    if (request) {
      delete request.input
      request.input_summary = {
        system_prompt_chars: input?.systemPrompt?.length ?? 0,
        messages: input?.messages?.length ?? 0,
        tools: input?.tools?.length ?? 0,
      }
    }
  }
  return clone
}

/**
 * `text` with every secret-shaped string replaced by `[redacted]`, and NUL
 * removed. The one scrub: the tee runs it over observations, and the Chief
 * of Staff over every message it sends a model (ADR-042).
 */
export function scrub(text: string): string {
  // Postgres refuses \u0000 in jsonb, and one refused batch blocks every later one.
  let out = text.replaceAll("\u0000", "")
  for (const shape of SECRET_SHAPES) out = out.replace(shape, "[redacted]")
  return out
}

/**
 * The `observe()` tee (§6.4, §10.6): every runtime event becomes one
 * `runtime.<kind>` row with the five ids and a `seq` allocated here, in
 * emission order, because only the facade sees emission order. The counter
 * is seeded from the sink's last seq at the first flush and re-seeded after
 * any failed one, so a restarted object never collides with its own past.
 * Flushes run under `waitUntil`, one at a time, in order.
 */
export function createTee(options: {
  sink: EventSink
  ids: TeeIds
  waitUntil: (promise: Promise<unknown>) => void
  clock?: () => Date
}): Tee {
  const { sink, ids } = options
  const clock = options.clock ?? (() => new Date())
  let pending: Pending[] = []
  let last: number | null = null
  let chain: Promise<void> = Promise.resolve()
  // The front of `pending` after an append that threw, which may still have committed.
  let unsure: { rows: number; seq: number } | null = null

  const row = (
    type: string,
    payload: Record<string, unknown>,
    occurredAt: string,
    taint: TaintLabel[] = []
  ): Pending => ({
    event_id: ulid(),
    org_id: ids.org_id,
    staff_id: ids.staff_id,
    assignment_id: ids.assignment_id,
    session_id: ids.session_id,
    type,
    occurred_at: occurredAt,
    idempotency_key: ulid(),
    taint,
    payload,
  })

  const flush = () => {
    // A failed flush must not take every later one with it.
    chain = chain
      .catch(() => undefined)
      .then(async () => {
        if (pending.length === 0) return
        const batch = pending
        pending = []
        try {
          if (last === null) {
            last = (await bounded(sink.lastSeq(ids.session_id))) ?? -1
            // It did commit: numbering it again would collide on every retry.
            if (unsure && last >= unsure.seq) batch.splice(0, unsure.rows)
            unsure = null
          }
          let seq = last
          const rows = batch.map((r) => ({ ...r, seq: ++seq }))
          try {
            await bounded(sink.append(rows))
          } catch (error) {
            unsure = { rows: rows.length, seq }
            throw error
          }
          last = seq
        } catch (error) {
          // Back to the front, unnumbered: the next flush re-reads the last
          // seq, so a half-written batch collides visibly rather than gaps.
          pending = [...batch, ...pending]
          last = null
          throw error
        }
      })
    const settled = chain.catch((error) => {
      console.error(
        JSON.stringify({
          tee: "flush failed",
          session_id: ids.session_id,
          error: error instanceof Error ? error.message : String(error),
        })
      )
    })
    options.waitUntil(settled)
    return settled
  }

  return {
    subscriber(observation) {
      // Streamed fragments: the completed message that follows holds the same text.
      if (observation.type.endsWith("_delta")) return
      pending.push(
        row(
          `runtime.${observation.type}`,
          redact(observation),
          observation.timestamp ?? clock().toISOString()
        )
      )
      flush()
    },
    emit(type, payload, taint) {
      pending.push(row(type, payload, clock().toISOString(), taint))
      flush()
    },
    flush,
  }
}
