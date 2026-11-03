import { PALETTES } from "@workspace/contracts"
import {
  conversationMessages,
  conversations,
  eq,
  type Tenancy,
  tenancy,
} from "@workspace/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Owner as Caller } from "../src/changes.ts"
import type { Held } from "../src/onboarding.ts"
import { finishedAt, logoRound } from "../src/workspace-tag.ts"
import { type Owner, owner } from "./owner-fixture.ts"

describe("the logo round the panel shows", () => {
  const caller = { orgId: "org", session: {} } as Caller
  const ids = ["a", "b", "c"].map(
    (c) => `${c}0000000-0000-4000-8000-000000000000`
  )
  const round = (status: string, variants: string[] = []) => ({
    round: 1,
    status,
    started_at: new Date().toISOString(),
    brief: {
      description: "A mark",
      colors: [PALETTES[0]?.primary],
      type: "lockup",
      style: "minimal",
    },
    planned: ids,
    styles: ["minimal", "minimal", "minimal"],
    variants,
  })
  const read = (manifest: object | null, facts: Held[] = []) =>
    logoRound(
      {
        SITES: {
          list: async () => ({ objects: manifest ? [{ key: "m" }] : [] }),
          get: async () => ({ etag: "e", json: async () => manifest }),
        },
      } as unknown as Env,
      caller,
      "call_1",
      facts
    )
  const kept = {
    key: "media.uploads",
    value: {
      items: [
        {
          id: ids[1],
          name: "Logo.png",
          content_type: "image/png",
          bytes: 1,
          use: "logo",
        },
      ],
    },
  } as unknown as Held

  it("says a round is drawing, then waits on a pick until one is kept", async () => {
    expect(await read(round("drawing"))).toEqual({
      status: "drawing",
      options: 3,
    })
    expect(await read(round("ready", ids))).toEqual({
      status: "ready",
      options: 3,
    })
    expect(await read(round("ready", ids), [kept])).toBeUndefined()
    expect(await read(round("failed"))).toBeUndefined()
    expect(await read(null)).toBeUndefined()
  })
})

/** The onboarding segment's finish time, on a live connection. */

const url = process.env.DATABASE_URL
const at = (minute: number) => new Date(Date.UTC(2026, 9, 25, 10, minute))

type Part = Record<string, unknown>
const card = (
  type: string,
  state: string,
  input: Part = { key: "x" }
): Part => ({ type, state, input })
const say: Part = { type: "text", text: "hello" }

describe.skipIf(!url)("when onboarding finished, on a live connection", () => {
  const kit: Tenancy = tenancy(url as string, { max: 2 })
  let who: Owner

  beforeAll(async () => {
    who = await owner(kit, url as string, "finished")
  }, 60_000)

  afterAll(() => kit.close())

  /** A new onboarding conversation holding `rows` in order: role, minute, parts. */
  const onboarding = (rows: [string, number, Part[]][]) =>
    kit.withOrg({ orgId: who.orgId }, async (db) => {
      // An org holds one onboarding conversation: the last case's becomes an assistant chat.
      await db
        .update(conversations)
        .set({ kind: "assistant" })
        .where(eq(conversations.kind, "onboarding"))
      const [made] = await db
        .insert(conversations)
        .values({
          orgId: who.orgId,
          kind: "onboarding",
          createdByStaffId: who.chiefId,
        })
        .returning({ id: conversations.id })
      const id = made?.id as string
      for (const [n, [role, minute, parts]] of rows.entries())
        await db.insert(conversationMessages).values({
          conversationId: id,
          orgId: who.orgId,
          format: "ai-sdk/v6",
          id: `m${n}`,
          parentId: n === 0 ? null : `m${n - 1}`,
          content: { role, parts },
          createdAt: at(minute),
        })
      return id
    })

  const finished = (id: string) =>
    kit.withOrg({ orgId: who.orgId }, (db) =>
      finishedAt(db, { id, updated_at: at(59) })
    )

  it("is the row after the newest settled card, not the conversation's last message", async () => {
    const id = await onboarding([
      ["assistant", 0, [card("tool-ask_choice", "output-available")]],
      ["user", 5, [say]],
      ["assistant", 6, [say, card("tool-ask_design", "output-available")]],
      ["user", 12, [say]],
      ["assistant", 13, [say]],
      // Later journeys write into the same conversation.
      ["assistant", 40, [card("tool-request_change", "output-available", {})]],
      ["user", 50, [say]],
    ])
    expect((await finished(id)).slice(11, 16)).toBe("10:12")
  })

  it("falls back to the card's own row when nothing follows it", async () => {
    const id = await onboarding([
      ["assistant", 3, [card("tool-ask_choice", "output-available")]],
    ])
    expect((await finished(id)).slice(11, 16)).toBe("10:03")
  })

  it("ignores a card still open, and falls back to the conversation's update", async () => {
    const id = await onboarding([
      ["assistant", 3, [card("tool-ask_choice", "input-available")]],
    ])
    expect((await finished(id)).slice(11, 16)).toBe("10:59")
  })
})
