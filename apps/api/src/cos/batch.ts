/**
 * The OpenRouter Batch API client (CM1): half-price inference for work that
 * can wait up to 24 hours and has no owner waiting. Built with its first
 * consumer, EV2's rubric sweep (`evals/rubric.mjs`), per the "no placeholder"
 * rule; the nightly CoS replay is the next one. It holds no state and reads no
 * environment: the caller passes the key and, in tests, `fetch`.
 *
 * Shape from OpenRouter's batch quickstart (checked 2026-10-14): `POST
 * /api/v1/batches` takes `endpoint` and `model` before an inline `requests`
 * array of `{custom_id, body}` (the API stream-parses and answers 400 when
 * `requests` comes first), answers 202 `validating`, and `GET /batches/:id`
 * carries `results` inline once the status is `completed`, each item exactly
 * one of `response` or `error`. Chat batches are text-only: an image has to be
 * a public URL, which is why the sweep scores a build from its HTML.
 */

export type BatchRequest = { custom_id: string; body: Record<string, unknown> }

export const TERMINAL = ["completed", "failed", "expired", "cancelled"] as const

export type BatchResult = {
  custom_id: string
  id?: string
  response: {
    status_code: number
    request_id?: string
    body: {
      choices?: { message?: { content?: unknown } }[]
      usage?: unknown
    }
  } | null
  error: unknown
}

export type Batch = {
  id: string
  status: string
  request_counts?: { total: number; completed: number; failed: number }
  results: BatchResult[] | null
  error?: unknown
}

export class BatchError extends Error {
  // No parameter property: `node --test` strips types and cannot compile one.
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = "BatchError"
  }
}

type Options = {
  apiKey: string
  fetch?: typeof fetch
  baseUrl?: string
  sleep?: (ms: number) => Promise<unknown>
}

/** The id the API takes: its model slug, never the catalogue's `:batch` variant name. */
export const slugOf = (model: string) => model.replace(/:batch$/, "")

export function batchClient(options: Options) {
  const call = options.fetch ?? fetch
  const base = options.baseUrl ?? "https://openrouter.ai/api/v1"
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))

  async function send(path: string, init?: RequestInit): Promise<Batch> {
    const response = await call(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
    })
    const text = await response.text()
    if (!response.ok) {
      throw new BatchError(
        `batch.http_${response.status}`,
        `OpenRouter answered ${response.status} on ${path}: ${text.slice(0, 500)}`
      )
    }
    return JSON.parse(text) as Batch
  }

  const get = (id: string) => send(`/batches/${encodeURIComponent(id)}`)

  return {
    /** Queues the requests on one model and chat endpoint. Ids must be unique. */
    submit(input: { model: string; requests: BatchRequest[] }) {
      if (input.requests.length === 0) {
        throw new BatchError(
          "batch.empty",
          "a batch needs at least one request"
        )
      }
      const ids = new Set(input.requests.map((r) => r.custom_id))
      if (ids.size !== input.requests.length) {
        throw new BatchError(
          "batch.duplicate_id",
          "custom_id repeats in a batch"
        )
      }
      // Key order matters: `requests` last.
      const body = {
        endpoint: "/v1/chat/completions",
        model: slugOf(input.model),
        requests: input.requests,
      }
      return send("/batches", { method: "POST", body: JSON.stringify(body) })
    },
    get,
    /**
     * Polls until the batch is terminal or `timeoutMs` has passed; the
     * returned status says which. A caller that cannot wait keeps the id and
     * calls `get` later, since results are kept 30 days.
     */
    async wait(
      id: string,
      wait: { everyMs?: number; timeoutMs?: number } = {}
    ): Promise<Batch> {
      const every = wait.everyMs ?? 60_000
      let left = wait.timeoutMs ?? 24 * 60 * 60 * 1000
      for (;;) {
        const batch = await get(id)
        if ((TERMINAL as readonly string[]).includes(batch.status)) return batch
        if (left <= 0) return batch
        await sleep(Math.min(every, left))
        left -= every
      }
    },
  }
}

/** Each request's reply text, or why it has none, by `custom_id`. */
export function textsOf(
  batch: Batch
): Map<string, { text: string } | { error: string }> {
  const out = new Map<string, { text: string } | { error: string }>()
  for (const item of batch.results ?? []) {
    const content = item.response?.body.choices?.[0]?.message?.content
    out.set(
      item.custom_id,
      typeof content === "string" && item.response?.status_code === 200
        ? { text: content }
        : {
            error: item.error
              ? JSON.stringify(item.error).slice(0, 300)
              : `status ${item.response?.status_code ?? "none"}, no text`,
          }
    )
  }
  return out
}
