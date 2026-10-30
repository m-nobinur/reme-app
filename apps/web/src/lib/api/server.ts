import { createServerFn } from "@tanstack/react-start"
import { getCookie } from "@tanstack/react-start/server"
import type { Conversation } from "@workspace/contracts"
import {
  ApprovalGrantSwitch,
  type ApprovalGrants,
  ChangeKind,
  DomainName,
  type DomainPurchaseStatus,
  GOAL_MAX,
  MemoryReviewAction,
  MemoryUndo,
  type MemoryView,
  MessageFeedback,
  PushSubscribeRequest,
  QuestionReply,
  RegistrantDetails,
  Reminder,
  SetTimeZoneRequest,
  Timestamp,
  Uuid,
} from "@workspace/contracts"
import type { CheckoutStart } from "@workspace/ui/components/assistant/buy-domain"
import { PANEL_COOKIE, RAIL_COOKIE } from "@workspace/ui/lib/panel"
import { titleText } from "@workspace/ui/lib/title"
import { EMPTY_WORKSPACE, readWorkspace, waitingOnOwner } from "@/lib/attention"
import { oneOf, record, text } from "@/lib/auth/input"
import { orgIntentCookie } from "@/lib/auth/org-intent"
import { seenAtOf, seenCookie } from "@/lib/notifications"
import { settingUp } from "@/lib/onboarding"
import { source } from "./source"
import type {
  AttentionItem,
  BusinessProfile,
  DecisionOutcome,
  OrgNode,
  OrgSummary,
  PipelineItem,
  PreviewLinks,
  StaffMember,
  TransportedMessage,
  Workspace,
  WriteOutcome,
} from "./types"

/**
 * The server half of every product screen. Loaders call these; nothing calls
 * `source` directly, so no implementation reaches the client graph and
 * `source.ts` stays the only module that names one.
 *
 * No function here names an organisation, and none accepts one: `apps/api`
 * resolves it from the forwarded session and refuses a session with none,
 * which is the shape §9.2 layer 1 requires and R3 states as "org_id never
 * comes from client input". Only the frame reads the organisation, for the
 * business name in the rail: a session belongs to at most one.
 */

/** An id off the wire: a UUID, or a refusal. */
function id(value: unknown): string {
  const read = Uuid.safeParse(value)
  if (!read.success) {
    throw new Error("Expected a UUID.")
  }
  return read.data
}

/** assistant-ui's local thread id, the key a first send is stored under. */
function localId(value: unknown): string {
  if (typeof value !== "string" || !/^[\w-]{1,64}$/.test(value)) {
    throw new Error("Expected a thread id.")
  }
  return value
}

/** The caller's idempotency key, or a fresh one: a key is never empty. */
const keyOf = (value: unknown) => text(value, 255) || crypto.randomUUID()

/** Reports and alerts for the rail's count, or null when they could not be read. */
async function readActivity(): Promise<AttentionItem[] | null> {
  try {
    return await source.activity()
  } catch {
    return null
  }
}

/** The conversations list for the rail, or null when it could not be read. */
async function readConversations(): Promise<Conversation[] | null> {
  try {
    return await source.conversations()
  } catch {
    return null
  }
}

/**
 * What the workspace frame needs on every /app page: the session's
 * organisation, whether the panel is open, and what is waiting on the owner.
 * The panel state is read here, on the server, so the first paint already has
 * the panel where the owner left it.
 */
export const getWorkspaceFrame = createServerFn({ method: "GET" }).handler(
  async (): Promise<{
    active: OrgSummary | null
    /** No organisation yet, and a business name signup could not write. */
    orgPending: boolean
    panelOpen: boolean
    railOpen: boolean
    /**
     * What waits on the owner, and where the site is. Null when the read
     * failed: the frame still renders, and says so.
     */
    workspace: Workspace | null
    /** The rail's conversations. Null when the read failed. */
    conversations: Conversation[] | null
    /** Staff names by id, for naming who asked in a polled workspace. */
    names: Record<string, string>
    /**
     * Reports and alerts from `/activity`, for the notifications page and
     * the rail's count. Null when the read failed.
     */
    activity: AttentionItem[] | null
    /** The newest notification the owner has seen in `active`, from their cookie. */
    seenAt: string | null
  }> => {
    const active = await source.org()
    if (!active) {
      return {
        active,
        orgPending: getCookie(orgIntentCookie()) !== undefined,
        // A business about to be made opens on its setup, panel and all.
        panelOpen: true,
        railOpen: getCookie(RAIL_COOKIE) !== "closed",
        workspace: EMPTY_WORKSPACE,
        conversations: [],
        names: {},
        activity: [],
        seenAt: null,
      }
    }
    const staff = source.staff()
    const [workspace, conversations, members, activity] = await Promise.all([
      readWorkspace(() => source.workspace(staff)),
      readConversations(),
      staff.catch(() => []),
      // ponytail: one more API read on every /app/* navigation; cache it, or read it only on the panel's timer, if frame latency shows it.
      readActivity(),
    ])
    return {
      active,
      orgPending: false,
      // Setup opens with the panel whatever was left from another business.
      panelOpen: getCookie(PANEL_COOKIE) !== "closed" || settingUp(workspace),
      railOpen: getCookie(RAIL_COOKIE) !== "closed",
      workspace,
      conversations,
      activity,
      seenAt: seenAtOf(getCookie(seenCookie(active.id))),
      names: Object.fromEntries(
        members.map((member) => [member.id, member.displayName])
      ),
    }
  }
)

/**
 * Whether `apps/api` holds a business for this session. False also for a
 * WorkOS organization with no row of ours, which naming the business repairs.
 */
export const hasBusiness = createServerFn({ method: "GET" }).handler(
  async (): Promise<boolean> => (await source.org()) !== null
)

/**
 * The panel's poll, with the tag it last saw. One request: `apps/api`
 * resolves the org from the session, and a session with none reads as an
 * empty workspace. A failure throws, so the poller backs off rather than
 * rendering a workspace of nothing.
 */
export const pollWorkspace = createServerFn({ method: "GET" })
  .validator((input: unknown) => ({
    etag: text(record(input).etag, 128) || null,
  }))
  .handler(
    async ({
      data,
    }): Promise<
      { changed: false } | { changed: true; workspace: Workspace }
    > => {
      const read = await source.pollWorkspace(data.etag)
      if (read === "unchanged") {
        return { changed: false }
      }
      return {
        changed: true,
        workspace: { ...read, attention: waitingOnOwner(read.attention) },
      }
    }
  )

/** The most an answer can weigh: a text answer is at most 500 characters. */
const ANSWER_BYTES = 2048

export const answerQuestion = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const data = record(input)
    if (JSON.stringify(data.reply ?? null).length > ANSWER_BYTES) {
      throw new Error("That answer is too long.")
    }
    return {
      conversationId: id(data.conversationId),
      reply: QuestionReply.parse(data.reply),
      key: keyOf(data.key),
    }
  })
  .handler(async ({ data }) => {
    return await source.answer(data.conversationId, data.reply, data.key)
  })

export const cancelBuild = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({
    assignmentId: id(record(input).assignmentId),
  }))
  .handler(async ({ data }): Promise<WriteOutcome> => {
    return await source.cancelBuild(data.assignmentId)
  })

export const deleteAccount = createServerFn({ method: "POST" }).handler(
  async (): Promise<WriteOutcome> => {
    return await source.deleteAccount()
  }
)

export const getPreview = createServerFn({ method: "GET" })
  .validator((input: unknown) => ({
    assignmentId: id(record(input).assignmentId),
  }))
  .handler(async ({ data }): Promise<PreviewLinks | null> => {
    return await source.preview(data.assignmentId)
  })

export const getSiteMedia = createServerFn({ method: "GET" }).handler(
  async () => await source.siteMedia()
)

export const askForChanges = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const data = record(input)
    const kind = ChangeKind.safeParse(data.changeKind)
    return {
      text: text(data.text, GOAL_MAX),
      key: keyOf(data.key),
      changeKind: kind.success ? kind.data : undefined,
      // The panel's note also lands in the chat; a named conversation is checked.
      chat: data.chat
        ? {
            conversation_id: record(data.chat).conversationId
              ? id(record(data.chat).conversationId)
              : undefined,
          }
        : undefined,
    }
  })
  .handler(async ({ data }): Promise<WriteOutcome> => {
    if (!data.text) {
      return { done: false, reason: "Write what should change first." }
    }
    return await source.requestChange(
      data.text,
      data.key,
      data.changeKind,
      data.chat
    )
  })

/**
 * The Checkout a domain purchase is paid in, with Stripe's public key to
 * mount it. Without the key this environment does not sell domains, and
 * the api is not asked.
 */
export const startDomainCheckout = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const data = record(input)
    return {
      name: DomainName.parse(data.name),
      details: RegistrantDetails.parse(data.details),
      key: keyOf(data.key),
    }
  })
  .handler(async ({ data }): Promise<CheckoutStart> => {
    const publishable = process.env.STRIPE_PUBLISHABLE_KEY
    if (!publishable) {
      return { outcome: "refused", code: "domain.buy_unavailable" }
    }
    const result = await source.domainCheckout(
      data.name,
      data.details,
      data.key
    )
    return "refused" in result
      ? { outcome: "refused", code: result.refused }
      : {
          outcome: "open",
          publishable_key: publishable,
          client_secret: result.client_secret,
        }
  })

/** Where a domain purchase stands, for the buy card after the payment. */
export const getDomainPurchase = createServerFn({ method: "GET" })
  .validator((input: unknown) => ({
    name: DomainName.parse(record(input).name),
  }))
  .handler(async ({ data }): Promise<DomainPurchaseStatus | null> => {
    return await source.domainStatus(data.name)
  })

/** The details page for buying a name, prefilled from what Reme holds. */
export const getDomainRegistrant = createServerFn({ method: "GET" })
  .validator((input: unknown) => ({
    name: DomainName.parse(record(input).name),
  }))
  .handler(async ({ data }) => await source.domainRegistrant(data.name))

/** A name the owner buys themselves, which the api then watches for. */
export const buyDomainElsewhere = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const data = record(input)
    return { name: DomainName.parse(data.name), key: keyOf(data.key) }
  })
  .handler(
    async ({ data }): Promise<WriteOutcome> =>
      await source.domainElsewhere(data.name, data.key)
  )

/** The owner's word that they bought it elsewhere. */
export const sayDomainBought = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const data = record(input)
    return { name: DomainName.parse(data.name), key: keyOf(data.key) }
  })
  .handler(async ({ data }) => await source.domainBought(data.name, data.key))

export const createReminder = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const data = record(input)
    const dueAt = Timestamp.nullable().safeParse(data.dueAt ?? null)
    if (!dueAt.success) {
      throw new Error("Expected a timestamp or null.")
    }
    return {
      title: text(data.title, Reminder.shape.title.maxLength ?? 200),
      dueAt: dueAt.data,
      key: keyOf(data.key),
    }
  })
  .handler(async ({ data }): Promise<WriteOutcome> => {
    if (!data.title) {
      return { done: false, reason: "Write what to remember first." }
    }
    return await source.createReminder(
      { title: data.title, due_at: data.dueAt },
      data.key
    )
  })

export const completeReminder = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ id: id(record(input).id) }))
  .handler(async ({ data }): Promise<WriteOutcome> => {
    return await source.completeReminder(data.id)
  })

export const deleteReminder = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ id: id(record(input).id) }))
  .handler(async ({ data }): Promise<WriteOutcome> => {
    return await source.deleteReminder(data.id)
  })

/** What the Chief of Staff remembers of the owner. */
export const getMemory = createServerFn({ method: "GET" }).handler(
  async (): Promise<MemoryView | null> => await source.memory()
)

/** One remembered change taken back; "stale" when nothing is left of it to undo. */
export const undoMemory = createServerFn({ method: "POST" })
  .validator((input: unknown) => MemoryUndo.parse(record(input)))
  .handler(
    async ({ data }): Promise<MemoryView | "stale" | null> =>
      await source.undoMemory(data.version)
  )

/** The owner's choice about being asked first, or their answer to one proposal. */
export const reviewMemory = createServerFn({ method: "POST" })
  .validator((input: unknown) => MemoryReviewAction.parse(record(input)))
  .handler(
    async ({ data }): Promise<MemoryView | "stale" | null> =>
      await source.reviewMemory(data)
  )

export const getGrants = createServerFn({ method: "GET" }).handler(
  async (): Promise<ApprovalGrants | null> => await source.grants()
)

/** The owner's switch on "Done without asking", for one kind. */
export const setGrant = createServerFn({ method: "POST" })
  .validator((input: unknown) => ApprovalGrantSwitch.parse(record(input)))
  .handler(
    async ({ data }): Promise<ApprovalGrants | null> =>
      await source.setGrant(data)
  )

/** The key a browser subscribes to push with; null where push is off. */
export const getPushKey = createServerFn({ method: "GET" }).handler(
  async (): Promise<string | null> => {
    return await source.pushKey()
  }
)

/** This browser's push subscription, saved. Its id, or null when refused. */
export const savePushSubscription = createServerFn({ method: "POST" })
  .validator((input: unknown) => PushSubscribeRequest.parse(record(input)))
  .handler(async ({ data }): Promise<string | null> => {
    return await source.subscribePush(data, crypto.randomUUID())
  })

export const removePushSubscription = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ id: id(record(input).id) }))
  .handler(async ({ data }): Promise<WriteOutcome> => {
    return await source.unsubscribePush(data.id)
  })

/** The zone this browser keeps, for the org's check-ins, quiet hours and reminders. */
export const syncTimeZone = createServerFn({ method: "POST" })
  .validator((input: unknown) => SetTimeZoneRequest.parse(record(input)))
  .handler(async ({ data }): Promise<void> => {
    await source.setTimeZone(data.time_zone)
  })

export const listConversations = createServerFn({ method: "GET" }).handler(
  async (): Promise<Conversation[]> => {
    return await source.conversations()
  }
)

/** Null for an id that is not one of the owner's, a UUID or not. */
export const getConversation = createServerFn({ method: "GET" })
  .validator((input: unknown) => {
    const read = Uuid.safeParse(record(input).id)
    return { id: read.success ? read.data : null }
  })
  .handler(async ({ data }): Promise<Conversation | null> => {
    return data.id ? await source.conversation(data.id) : null
  })

/**
 * Idempotent on the thread's local id, so a retried first send makes one
 * row. Null for a session with no organisation, which has nowhere to store
 * one; the thread then stays in the tab.
 */
export const createConversation = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ key: localId(record(input).localId) }))
  .handler(async ({ data }): Promise<Conversation | null> => {
    return await source.createConversation(data.key)
  })

export const updateConversation = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const data = record(input)
    if (typeof data.archived === "boolean") {
      return {
        id: id(data.id),
        patch: { archived: data.archived },
        key: keyOf(data.key),
      }
    }
    // Kept the way the api keeps a title: one line, single spaces, cut to
    // 120 UTF-16 units before a character rather than inside one.
    const title = titleText(typeof data.title === "string" ? data.title : "")
    if (!title) throw new Error("A title needs words.")
    return { id: id(data.id), patch: { title }, key: keyOf(data.key) }
  })
  .handler(async ({ data }): Promise<void> => {
    await source.updateConversation(data.id, data.patch, data.key)
  })

/**
 * The owner's thumb on a reply. The key is the press's own, minted in the
 * browser, so a retry of that press records nothing new and a later press
 * is a new rating, the latest of which wins.
 */
export const rateMessage = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const data = record(input)
    return {
      id: id(data.id),
      feedback: MessageFeedback.parse({
        message_id: data.message_id,
        rating: data.rating,
      }),
      key: keyOf(data.key),
    }
  })
  .handler(async ({ data }): Promise<void> => {
    await source.rateMessage(data.id, data.feedback, data.key)
  })

export const getConversationMessages = createServerFn({ method: "GET" })
  .validator((input: unknown) => ({ id: id(record(input).id) }))
  .handler(async ({ data }): Promise<TransportedMessage[]> => {
    return await source.conversationMessages(data.id)
  })

export const getStaffDirectory = createServerFn({ method: "GET" }).handler(
  async (): Promise<{
    staff: StaffMember[]
    tree: OrgNode[]
  }> => await source.directory()
)

export const decideApproval = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const data = record(input)
    return {
      approvalId: text(data.approvalId, 64),
      // The revision the owner was shown, which the decision binds to.
      revisionId: text(data.revisionId, 64),
      decision: oneOf(data.decision, ["approved", "rejected"] as const),
    }
  })
  .handler(async ({ data }): Promise<DecisionOutcome> => {
    if (!data.approvalId || !data.revisionId) {
      throw new Error("no approval to decide")
    }
    return await source.decideApproval(
      data.approvalId,
      data.revisionId,
      data.decision
    )
  })

export const getPipeline = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ items: PipelineItem[] }> => ({
    items: await source.pipeline(),
  })
)

export const getBusinessProfile = createServerFn({ method: "GET" }).handler(
  async (): Promise<BusinessProfile | null> => await source.profile()
)
