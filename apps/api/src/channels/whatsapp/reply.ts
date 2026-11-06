import { Choices, PERSONA_CARD } from "@workspace/contracts"
import {
  conversationMessages,
  eq,
  type OrgScopedDb,
  orgs,
  sql,
  type Tenancy,
} from "@workspace/db"
import type { UIMessage } from "ai"
import { splitText, whatsAppText } from "./format.ts"
import {
  type Graph,
  GraphFailed,
  graphOf,
  sendInteractive,
  sendText,
} from "./graph.ts"

/** WhatsApp's limits on an interactive message. */
const BODY_MAX = 1024
const TITLE_MAX = 20
const WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * The approvals a tap may answer. Every other card (an Always-ask one, a
 * grant, a contact or a domain change) is decided on the web, where its
 * whole record shows.
 */
const BUTTON_TOOLS: ReadonlySet<string> = new Set(["create_reminder"])

const STALE = "That button is out of date. Tell me what you'd like."

/** What goes after the reply's words, if anything. */
export type Extra =
  | { kind: "approval"; id: string }
  | { kind: "choices"; choices: Choices }
  | { kind: "link"; label: string; body: string }
  | null

type Waiting = { type: string; state?: string; [key: string]: unknown }

const clip = (label: string) =>
  label.length > TITLE_MAX
    ? `${label.slice(0, TITLE_MAX - 1).trimEnd()}…`
    : label

/** The step after the last `step-start`, which holds the calls still waiting on the owner. */
function lastStep(parts: Waiting[]): Waiting[] {
  return parts.slice(parts.map((p) => p.type).lastIndexOf("step-start") + 1)
}

/**
 * How a reply asks for what comes next. One waiting approval of a button
 * tool is Approve and Not now; any other card is a link to the web; with
 * nothing waiting, the quick replies are up to 3 buttons.
 */
export function extraOf(message: UIMessage, hasText: boolean): Extra {
  const parts = message.parts as unknown as Waiting[]
  const waiting = lastStep(parts).filter(
    (p) =>
      p.type.startsWith("tool-") &&
      (p.state === "input-available" || p.state === "approval-requested")
  )
  const approvals = waiting.filter((p) => p.state === "approval-requested")
  const only = waiting.length === 1 ? approvals[0] : undefined
  const id = (only?.approval as { id?: string } | undefined)?.id
  if (only && id && hasText && BUTTON_TOOLS.has(only.type.slice(5))) {
    return { kind: "approval", id }
  }
  if (approvals.length > 0) {
    return {
      kind: "link",
      label: "Open Reme to approve",
      body: "There's something to approve in Reme.",
    }
  }
  if (
    waiting.length > 0 ||
    lastStep(parts).some(
      (p) => p.type === PERSONA_CARD || p.type === "data-build_questions"
    )
  ) {
    return {
      kind: "link",
      label: "Open in Reme",
      body: "There's more to see in Reme.",
    }
  }
  const offered = choicesOf(parts)
  return offered ? { kind: "choices", choices: offered } : null
}

function choicesOf(parts: Waiting[]): Choices | null {
  const offer = lastStep(parts).find((p) => p.type === "tool-offer_choices")
  const choices = Choices.safeParse(
    (offer?.input as { choices?: unknown } | undefined)?.choices
  )
  return choices.success ? choices.data : null
}

const interactive = (
  body: string,
  extra: NonNullable<Extra>,
  url: () => string
) => {
  if (extra.kind === "link") {
    return {
      type: "cta_url",
      body: { text: body },
      action: {
        name: "cta_url",
        parameters: { display_text: extra.label, url: url() },
      },
    }
  }
  const buttons =
    extra.kind === "approval"
      ? [
          { id: `ap:${extra.id}:y`, title: "Approve" },
          { id: `ap:${extra.id}:n`, title: "Not now" },
        ]
      : extra.choices.map((c, i) => ({ id: `ch:${i}`, title: clip(c.label) }))
  return {
    type: "button",
    body: { text: body },
    action: {
      buttons: buttons.map((reply) => ({ type: "reply", reply })),
    },
  }
}

/**
 * The reply as WhatsApp messages: its words in as few as fit, and its
 * buttons on the last when that is short enough to be a button message's
 * body. Buttons that cannot be sent leave the words as plain text.
 */
export async function sendReply(
  graph: Graph,
  to: string,
  reply: string,
  extra: Extra,
  conversationUrl: () => string
): Promise<void> {
  const parts = reply ? splitText(whatsAppText(reply)) : []
  const tail = parts.at(-1)
  const joined = extra && tail !== undefined && tail.length <= BODY_MAX
  const body = joined
    ? (tail as string)
    : extra?.kind === "link"
      ? extra.body
      : "What would you like to do?"
  try {
    for (const part of joined ? parts.slice(0, -1) : parts) {
      await sendText(graph, to, part)
    }
    if (!extra) return
    try {
      await sendInteractive(
        graph,
        to,
        interactive(body, extra, conversationUrl)
      )
    } catch (error) {
      if (!(error instanceof GraphFailed)) throw error
      console.error(
        JSON.stringify({
          code: "whatsapp.buttons_failed",
          graph: error.message,
        })
      )
      if (joined) await sendText(graph, to, body)
    }
  } catch (error) {
    // The reply is on the web either way; a resend would repeat its first part.
    if (!(error instanceof GraphFailed)) throw error
    console.error(
      JSON.stringify({ code: "whatsapp.reply_failed", graph: error.message })
    )
  }
}

export const sendStale = (graph: Graph, to: string) =>
  sendText(graph, to, STALE).catch((error: unknown) => {
    if (!(error instanceof GraphFailed)) throw error
  })

/** A tap on one of the buttons, from the webhook's `interactive.button_reply`. */
export type Tap =
  | { kind: "approval"; approvalId: string; approved: boolean }
  | { kind: "choice"; index: number; title: string }

const APPROVAL_ID = /^ap:([\x21-\x7E]{1,128}):([yn])$/
const CHOICE_ID = /^ch:([0-2])$/

export function tapOf(body: Record<string, unknown>): Tap | null {
  if (body.type !== "interactive") return null
  const reply = (
    body.interactive as
      | { type?: string; button_reply?: { id?: unknown; title?: unknown } }
      | undefined
  )?.button_reply
  if (typeof reply?.id !== "string") return null
  const approval = APPROVAL_ID.exec(reply.id)
  if (approval) {
    return {
      kind: "approval",
      approvalId: approval[1] as string,
      approved: approval[2] === "y",
    }
  }
  const choice = CHOICE_ID.exec(reply.id)
  return choice && typeof reply.title === "string"
    ? { kind: "choice", index: Number(choice[1]), title: reply.title }
    : null
}

/**
 * What a tap on a quick reply sends: its message, while the conversation's
 * newest message is still the one that offered it. Null once anything newer
 * landed, or when the title is not the button's.
 */
export async function choiceText(
  db: OrgScopedDb,
  conversationId: string,
  tap: Extract<Tap, { kind: "choice" }>
): Promise<string | null> {
  const [tail] = await db
    .select({ content: conversationMessages.content })
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, conversationId))
    .orderBy(sql`${conversationMessages.seq} desc`)
    .limit(1)
  const content = tail?.content as
    | { role?: string; parts?: Waiting[] }
    | undefined
  const choice =
    content?.role === "assistant"
      ? choicesOf(content.parts ?? [])?.[tap.index]
      : undefined
  return choice && clip(choice.label) === tap.title ? choice.send : null
}

/**
 * The stored message holding the card an Approve or Not now answers, when
 * that card is still waiting and is one a tap may answer. A results turn
 * continues this message, so its stream is read on top of it.
 */
export async function approvalMessage(
  db: OrgScopedDb,
  conversationId: string,
  approvalId: string
): Promise<UIMessage | null> {
  const [row] = await db
    .select({
      id: conversationMessages.id,
      content: conversationMessages.content,
    })
    .from(conversationMessages)
    .where(
      sql`${conversationMessages.conversationId} = ${conversationId} and exists (
        select 1 from jsonb_array_elements(${conversationMessages.content}->'parts') p
        where p->>'state' = 'approval-requested'
          and p->'approval'->>'id' = ${approvalId}
          and substr(p->>'type', 6) in ${[...BUTTON_TOOLS]})`
    )
    .orderBy(sql`${conversationMessages.seq} desc`)
    .limit(1)
  return row
    ? ({
        ...row.content,
        id: row.id,
        role: "assistant",
      } as unknown as UIMessage)
    : null
}

/** A short line from the business to a chat, inside its open window; a failed send is logged. */
export async function tell(
  env: Pick<Env, "CHANNEL_TOKEN_KEY">,
  kit: Tenancy,
  orgId: string,
  to: string,
  words: (business: string) => string
): Promise<void> {
  const found = await kit.withOrg({ orgId }, async (db) => {
    const [org] = await db.select({ name: orgs.name }).from(orgs)
    const graph = await graphOf(env, db, orgId)
    return org && graph ? { name: org.name, graph } : null
  })
  if (!found) return
  try {
    await sendText(found.graph, to, words(found.name))
  } catch (error) {
    if (!(error instanceof GraphFailed)) throw error
    console.error(
      JSON.stringify({ code: "whatsapp.tell_failed", graph: error.message })
    )
  }
}

/**
 * "Disconnected from <business>." to a chat that was just ended, when its
 * 24-hour window is open: Meta takes nothing else outside it.
 */
export const sayGoodbye = (
  env: Pick<Env, "CHANNEL_TOKEN_KEY">,
  kit: Tenancy,
  orgId: string,
  to: string,
  lastInboundAt: Date | null
) =>
  lastInboundAt && Date.now() - lastInboundAt.getTime() <= WINDOW_MS
    ? tell(env, kit, orgId, to, (name) => `Disconnected from ${name}.`)
    : Promise.resolve()
