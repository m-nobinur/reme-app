import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import type {
  MessageFormatAdapter,
  MessageStorageEntry,
} from "@assistant-ui/react"
import type { Conversation, ConversationMessage } from "@workspace/contracts"
import { expect, expectTypeOf, it, vi } from "vitest"
import type { TransportedMessage } from "../lib/api/types"
import {
  type AISDKStorageFormat,
  conversationHistory,
  lastChat,
  missingConversations,
  STORAGE_FORMAT,
  startsNewChat,
  toMetadata,
  toStorageEntry,
  toUIMessage,
} from "./history"
import type { ChatMessage } from "./message"

/**
 * `@assistant-ui/ai-sdk` exports neither its format adapter nor its storage
 * type, so the adapter is loaded from the installed package's own file: the
 * format it names, and the decode the runtime runs on our rows.
 */
const require = createRequire(import.meta.url)
const aiSdk = dirname(
  createRequire(require.resolve("@assistant-ui/react-ai-sdk")).resolve(
    "@assistant-ui/ai-sdk"
  )
)
const ADAPTER_FILE = join(aiSdk, "adapters", "aiSDKFormatAdapter.js")
const installed = async () =>
  (await import(pathToFileURL(ADAPTER_FILE).href))
    .aiSDKV6FormatAdapter as MessageFormatAdapter<
    ChatMessage,
    AISDKStorageFormat
  >

const AT = "2026-09-26T10:00:00.000Z"
const ROWS: TransportedMessage[] = [
  {
    id: "msg_1",
    parent_id: null,
    format: "ai-sdk/v6",
    content: {
      role: "user",
      parts: [{ type: "text", text: "Change the hero" }],
      metadata: { custom: { createdAt: AT } },
    },
    feedback: null,
  },
  {
    id: "msg_2",
    parent_id: "msg_1",
    format: "ai-sdk/v6",
    content: {
      role: "assistant",
      parts: [{ type: "text", text: "On it." }],
      metadata: { custom: { createdAt: AT } },
    },
    feedback: null,
  },
]

it("pins the format the installed AI SDK adapter writes", async () => {
  expect((await installed()).format).toBe(STORAGE_FORMAT)
})

it("maps a stored row onto the storage entry by every field but the parts", () => {
  // The contract keeps parts open and the AI SDK types them as its union;
  // everything else must line up without a cast.
  expectTypeOf<Omit<ConversationMessage, "content">>().toMatchTypeOf<
    Omit<MessageStorageEntry<AISDKStorageFormat>, "content">
  >()
  expectTypeOf<Omit<ConversationMessage["content"], "parts">>().toMatchTypeOf<
    Omit<AISDKStorageFormat, "parts">
  >()
  expect(toStorageEntry(ROWS[1] as TransportedMessage)).toEqual({
    id: "msg_2",
    parent_id: "msg_1",
    format: "ai-sdk/v6",
    content: ROWS[1]?.content,
  })
})

it("loads the open thread's rows through the runtime's own decode", async () => {
  const read = vi.fn(async () => ROWS)
  const history = conversationHistory(() => "conv-1", read)
  const repo = await history.withFormat?.(await installed()).load()
  expect(read).toHaveBeenCalledWith("conv-1")
  expect(repo?.messages).toEqual([
    {
      parentId: null,
      message: {
        id: "msg_1",
        role: "user",
        parts: [{ type: "text", text: "Change the hero" }],
        // The date S2's divider reads survives the decode.
        metadata: { custom: { createdAt: AT } },
      },
    },
    expect.objectContaining({ parentId: "msg_1" }),
  ])
})

it("reloads a row after a failed turn exactly as a history load decodes it", async () => {
  const format = await installed()
  for (const row of ROWS) {
    expect(toUIMessage(row)).toEqual(format.decode(toStorageEntry(row)).message)
  }
})

it("loads nothing for a thread that is not stored yet", async () => {
  const read = vi.fn(async () => ROWS)
  const history = conversationHistory(() => undefined, read)
  expect(await history.withFormat?.(await installed()).load()).toEqual({
    messages: [],
  })
  expect(read).not.toHaveBeenCalled()
})

it("never writes: the server stored the turn", async () => {
  const read = vi.fn(async () => ROWS)
  const history = conversationHistory(() => "conv-1", read)
  const format = await installed()
  await history.withFormat?.(format).append({
    parentId: null,
    message: { id: "forged", role: "user", parts: [] },
  })
  await history.append({} as never)
  expect(read).not.toHaveBeenCalled()
})

it("refuses a runtime that asks for another format", () => {
  const history = conversationHistory(
    () => "conv-1",
    async () => ROWS
  )
  expect(() =>
    history.withFormat?.({
      format: "ai-sdk/v7",
      encode: () => ({}),
      decode: () => ({ parentId: null, message: {} }),
      getId: () => "",
    })
  ).toThrow(/ai-sdk\/v6/)
})

it("lists an archived conversation as archived, and an untitled one without a title", () => {
  const conversation: Conversation = {
    id: "00000000-0000-4000-8000-00000000000a",
    kind: "assistant",
    title: null,
    archived_at: AT,
    created_at: AT,
    updated_at: AT,
  }
  expect(toMetadata(conversation)).toEqual({
    remoteId: conversation.id,
    status: "archived",
    title: undefined,
  })
  expect(
    toMetadata({ ...conversation, archived_at: null, title: "Prices" })
  ).toMatchObject({ status: "regular", title: "Prices" })
})

it("picks the open conversation the owner was last active in", () => {
  const chat = (id: string, updated: string, archived = false) =>
    ({
      id,
      kind: "assistant",
      title: null,
      archived_at: archived ? AT : null,
      created_at: AT,
      updated_at: updated,
    }) satisfies Conversation
  expect(lastChat(null)).toBeUndefined()
  expect(lastChat([])).toBeUndefined()
  expect(
    lastChat([
      chat("older", "2026-09-26T10:00:00.000Z"),
      chat("newer", "2026-09-27T10:00:00.000Z"),
      chat("oldest", "2026-09-25T10:00:00.000Z"),
    ])?.id
  ).toBe("newer")
  // Archived is gone from the history menu, so never the last chat.
  expect(
    lastChat([
      chat("open", "2026-09-26T10:00:00.000Z"),
      chat("archived", "2026-09-28T10:00:00.000Z", true),
    ])?.id
  ).toBe("open")
  expect(
    lastChat([chat("archived", "2026-09-28T10:00:00.000Z", true)])
  ).toBeUndefined()
})

it("starts a new chat only for a new New chat press", () => {
  expect(startsNewChat(undefined, "a")).toBe(true)
  expect(startsNewChat("a", "b")).toBe(true)
  // A replace navigation or a rail link carries no state: the first send of
  // a new chat must survive it.
  expect(startsNewChat("a", undefined)).toBe(false)
  expect(startsNewChat("a", "a")).toBe(false)
})

it("remembers a conversation the owner cannot open, and says so", () => {
  const seen: boolean[] = []
  const stop = missingConversations.subscribe(() =>
    seen.push(missingConversations.has("conv-9"))
  )
  expect(missingConversations.has("conv-9")).toBe(false)
  missingConversations.add("conv-9")
  expect(seen).toEqual([true])
  stop()
})

it("reads a rated reply back with its thumb, on both ways a row loads", async () => {
  const format = await installed()
  const rated = (feedback: "up" | "down" | null): TransportedMessage => ({
    ...(ROWS[1] as TransportedMessage),
    feedback,
  })
  expect(toUIMessage(rated("up")).metadata).toMatchObject({
    submittedFeedback: { type: "positive" },
  })
  expect(toUIMessage(rated("down")).metadata).toMatchObject({
    submittedFeedback: { type: "negative" },
  })
  expect(toUIMessage(rated(null)).metadata).not.toHaveProperty(
    "submittedFeedback"
  )
  // A history load decodes the same thumb a reload after a failed turn shows.
  expect(format.decode(toStorageEntry(rated("down"))).message).toEqual(
    toUIMessage(rated("down"))
  )
})
