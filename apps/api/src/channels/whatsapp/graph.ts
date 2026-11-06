import { type OrgScopedDb, whatsappAccounts } from "@workspace/db"
import { openToken } from "../token.ts"

export const GRAPH = "https://graph.facebook.com/v24.0"

/** Too many messages to one person in a short time: wait, then send again. */
export const PAIR_RATE_LIMIT = 131056
/** The 24-hour window is closed: only a template may go. */
export const OUTSIDE_WINDOW = 131047

const BACKOFF_MS = [2_000, 4_000]

/** One business number's sender: its Meta id and its token, opened. */
export type Graph = { phoneNumberId: string; token: string }

export class GraphFailed extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined
  ) {
    super(`graph.${code ?? status}`)
  }
}

/** The org's number and token, in a transaction holding its context. */
export async function graphOf(
  env: Pick<Env, "CHANNEL_TOKEN_KEY">,
  db: OrgScopedDb,
  orgId: string
): Promise<Graph | null> {
  const [account] = await db
    .select({
      phoneNumberId: whatsappAccounts.phoneNumberId,
      sealed: whatsappAccounts.tokenCiphertext,
    })
    .from(whatsappAccounts)
  if (!account) return null
  return {
    phoneNumberId: account.phoneNumberId,
    token: await openToken(env, orgId, account.sealed),
  }
}

async function call<T>(graph: Graph, path: string, body?: object): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${GRAPH}/${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${graph.token}`,
        ...(body && { "content-type": "application/json" }),
      },
      body: body ? JSON.stringify(body) : null,
      signal: AbortSignal.timeout(10_000),
    })
    const json = (await response.json().catch(() => null)) as {
      error?: { code?: number }
    } | null
    if (response.ok) return json as T
    const code = json?.error?.code
    const wait = BACKOFF_MS[attempt]
    if (code === PAIR_RATE_LIMIT && wait) {
      await new Promise((resolve) => setTimeout(resolve, wait))
      continue
    }
    if (code === OUTSIDE_WINDOW) {
      // shortcut: logged only, until the updates story sends a template instead.
      console.warn(JSON.stringify({ code: "whatsapp.outside_window" }))
    }
    throw new GraphFailed(response.status, code)
  }
}

const message = (graph: Graph, to: string, content: object) =>
  call<{ messages: { id: string }[] }>(
    graph,
    `${graph.phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      ...content,
    }
  )

export const sendText = (graph: Graph, to: string, body: string) =>
  message(graph, to, { type: "text", text: { preview_url: false, body } })

export const sendInteractive = (
  graph: Graph,
  to: string,
  interactive: object
) => message(graph, to, { type: "interactive", interactive })

export const sendTemplate = (
  graph: Graph,
  to: string,
  template: { name: string; language: { code: string }; components?: object[] }
) => message(graph, to, { type: "template", template })

/** Marks the owner's message read and shows typing, for 25 s or until the reply. */
export const markRead = (graph: Graph, messageId: string) =>
  call(graph, `${graph.phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
    typing_indicator: { type: "text" },
  })

/** Where a received photo or voice note can be fetched, for 5 minutes. */
export const mediaUrl = (graph: Graph, mediaId: string) =>
  call<{ url: string; mime_type: string; file_size?: number }>(graph, mediaId)

export async function downloadMedia(
  graph: Graph,
  url: string
): Promise<ArrayBuffer> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${graph.token}` },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new GraphFailed(response.status, undefined)
  return response.arrayBuffer()
}
