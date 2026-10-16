// Aliased on import, as in ./pending.ts: a server helper, not a React hook.
import { useSession as openSession } from "@tanstack/react-start/server"

/**
 * A signup whose organisation was not written. The business name is kept,
 * sealed, until a later request writes it, because the flow cookie that
 * carried it through signup is cleared once the person is signed in and
 * nothing else remembers what they asked for.
 *
 * Sealed like the flow cookie, and kept 30 days rather than ten minutes: the
 * retry waits on the person coming back. `userId` binds it to the account
 * that signed up, so a different sign-in in the same browser ignores it.
 */
type OrgIntent = { userId: string; orgName: string }

export const ORG_INTENT = "reme-org-intent"

function config() {
  const password = process.env.WORKOS_COOKIE_PASSWORD
  if (!password) {
    throw new Error("WORKOS_COOKIE_PASSWORD is not set on this Worker.")
  }
  return {
    name: ORG_INTENT,
    password,
    maxAge: 30 * 24 * 60 * 60,
    sessionHeader: false as const,
  }
}

export async function recordOrgIntent(intent: OrgIntent): Promise<void> {
  const session = await openSession<OrgIntent>(config())
  await session.update(intent)
}

export async function readOrgIntent(): Promise<OrgIntent | null> {
  const { userId, orgName } = (await openSession<OrgIntent>(config())).data
  return userId && orgName ? { userId, orgName } : null
}

export async function clearOrgIntent(): Promise<void> {
  await (await openSession<OrgIntent>(config())).clear()
}
