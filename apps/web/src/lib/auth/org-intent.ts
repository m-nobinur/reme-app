import {
  clearSealed,
  cookieName,
  readSealed,
  writeSealed,
} from "./sealed-cookie"

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

const NAME = "reme-org-intent"
const LIFETIME_MS = 30 * 24 * 60 * 60 * 1000

/** The cookie as the browser holds it, for a check that it is there at all. */
export const orgIntentCookie = () => cookieName(NAME)

export async function recordOrgIntent(intent: OrgIntent): Promise<void> {
  await writeSealed(NAME, intent, Date.now() + LIFETIME_MS)
}

export async function readOrgIntent(): Promise<OrgIntent | null> {
  const sealed = await readSealed<OrgIntent>(NAME)
  return sealed?.userId && sealed.orgName
    ? { userId: sealed.userId, orgName: sealed.orgName }
    : null
}

export async function clearOrgIntent(): Promise<void> {
  clearSealed(NAME)
}
