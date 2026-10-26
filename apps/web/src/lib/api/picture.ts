import { getAuth } from "@workos/authkit-tanstack-react-start"
import { ownerFrom } from "@/lib/tenant"

/**
 * A same-origin door to one of `apps/api`'s pictures of the signed-in
 * owner's org. Only the session cookie travels; the api scopes the read to
 * that session's org, and only the picture's type and caching come back
 * with its bytes.
 */
export async function relayPicture(
  read: () => Promise<Response | null>
): Promise<Response> {
  const answer = ownerFrom(await getAuth()) ? await read() : null
  if (!answer) return new Response(null, { status: 401 })
  if (!answer.ok) return new Response(null, { status: answer.status })
  const headers = new Headers()
  for (const name of [
    "content-type",
    "cache-control",
    "x-content-type-options",
  ]) {
    const value = answer.headers.get(name)
    if (value) headers.set(name, value)
  }
  return new Response(answer.body, { headers })
}
