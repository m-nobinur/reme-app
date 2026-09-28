import { useState } from "react"

/**
 * What the ··· menu does to a stored conversation, apart from the screen it
 * runs on, so the rules can be tested alone.
 */

/**
 * The title the rename form starts from: the stored one, not the label the
 * app shows for an untitled conversation, which saved unchanged would become
 * its title.
 */
export const titleToEdit = (stored: { title: string | null }) =>
  stored.title ?? ""

/**
 * Which conversation is being renamed, and which one's archive failed. Both
 * clear when the owner moves to another conversation or page, so a form or
 * an alert never waits for them on their return.
 */
export function useMenuState(id: string | undefined) {
  const [shown, setShown] = useState(id)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  if (shown !== id) {
    setShown(id)
    setRenaming(null)
    setFailed(null)
  }
  return { renaming, setRenaming, failed, setFailed }
}

/**
 * Archives a conversation. The owner leaves it for a new chat only if they
 * are still on it when the api answers: one who moved on meanwhile stays
 * where they went. False when the archive failed.
 */
export async function archiveConversation(
  id: string,
  {
    update,
    stillOn,
    leave,
  }: {
    update: (id: string) => Promise<void>
    stillOn: (id: string) => boolean
    leave: () => Promise<void>
  }
): Promise<boolean> {
  try {
    await update(id)
  } catch {
    return false
  }
  if (stillOn(id)) await leave()
  return true
}

/**
 * Saves a new title, unless it is the one already stored. Saving the label
 * the app shows for an untitled conversation would store it, and stop the
 * api naming the conversation from its first message.
 */
export async function saveTitle(
  stored: { id: string; title: string | null },
  title: string,
  update: (id: string, title: string) => Promise<void>
): Promise<void> {
  if (title === stored.title) return
  await update(stored.id, title)
}
