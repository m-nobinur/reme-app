import {
  conversationMessages,
  conversations,
  eq,
  staff,
  type Tenancy,
} from "@workspace/db"

/** Gives the org the assistant conversation a post lands in. */
export async function openChat(kit: Tenancy, orgId: string): Promise<void> {
  await kit.withOrg({ orgId }, async (db) => {
    const [chief] = await db
      .select({ id: staff.id })
      .from(staff)
      .where(eq(staff.staffCode, "COS-001"))
    await db.insert(conversations).values({
      orgId,
      kind: "assistant",
      createdByStaffId: chief?.id as string,
    })
  })
}

/** Every text the assistant has posted in the org's chat, one entry per message. */
export async function chatTexts(
  kit: Tenancy,
  orgId: string
): Promise<string[]> {
  const rows = await kit.withOrg({ orgId }, (db) =>
    db
      .select({ content: conversationMessages.content })
      .from(conversationMessages)
  )
  return rows.map((row) =>
    (row.content as { parts: { type: string; text?: string }[] }).parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ")
  )
}
