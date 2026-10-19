import {
  deleteCookie,
  getCookie,
  setCookie,
} from "@tanstack/react-start/server"
import { sessionEncryption } from "@workos/authkit-session"
import { cookiePassword } from "./workos"

/**
 * A small sealed cookie for state that crosses a redirect: the half-finished
 * sign-in and the business name a signup left unwritten.
 *
 * Sealed by the AuthKit kit's `sessionEncryption`, the iron format the session
 * cookie and `transport.ts` already use (AES-256-CBC with SHA-256 integrity),
 * over the same password. TanStack Start 1.169 removed the `useSession` these
 * used to be sealed by. Its seal wrapped the state in its own record, so a
 * cookie written before the move reads as absent: a sign-in in flight at
 * deploy time starts again, and a pending business name is asked for again.
 *
 * `__Host-` on https, as the session cookie is (`sessionCookie()`), so a
 * sibling host cannot plant one; a browser drops it without `Secure`, so local
 * http keeps the plain name.
 */
const https = () =>
  process.env.WORKOS_REDIRECT_URI?.startsWith("https:") === true

export const cookieName = (name: string) => (https() ? `__Host-${name}` : name)

/** The sealed record: the caller's fields plus when it stops being read. */
type Sealed<T> = T & { expiresAt: number }

/** The record, or null when it is missing, expired, tampered or in the old format. */
export async function readSealed<T extends object>(
  name: string
): Promise<Sealed<T> | null> {
  const value = getCookie(cookieName(name))
  if (!value) {
    return null
  }
  try {
    const data = await sessionEncryption.unsealData<Sealed<T>>(value, {
      password: cookiePassword(),
    })
    return typeof data?.expiresAt === "number" && data.expiresAt > Date.now()
      ? data
      : null
  } catch {
    return null
  }
}

/**
 * Seals `data` until `expiresAt` (ms since epoch). An update passes the
 * expiry it read, so a step in the flow does not extend the flow's lifetime.
 */
export async function writeSealed(
  name: string,
  data: object,
  expiresAt: number
): Promise<void> {
  const maxAge = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000))
  const sealed = await sessionEncryption.sealData(
    { ...data, expiresAt },
    { password: cookiePassword(), ttl: maxAge }
  )
  setCookie(cookieName(name), sealed, {
    path: "/",
    httpOnly: true,
    secure: https(),
    // Lax, the browser default Start's cookie had: the WorkOS and Google
    // callbacks arrive as cross-site top-level navigations.
    sameSite: "lax",
    maxAge,
  })
}

export function clearSealed(name: string): void {
  deleteCookie(cookieName(name), {
    path: "/",
    httpOnly: true,
    secure: https(),
    sameSite: "lax",
  })
}
