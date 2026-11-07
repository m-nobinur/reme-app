import { WhatsAppAccount, WhatsAppSignupComplete } from "@workspace/contracts"
import {
  type Tenancy,
  whatsAppAccountByPhone,
  whatsappAccounts,
} from "@workspace/db"
import type { Owner } from "../../changes.ts"
import { constraint, failure, invalid, readBody } from "../../http.ts"
import { sealToken } from "../token.ts"
import { GRAPH } from "./graph.ts"

/**
 * Embedded Signup v4, the server half. The popup hands the browser a 30-second
 * code plus the WABA and phone number ids; this exchanges the code for the
 * business's token, checks that token reaches that number, registers the
 * number (a number already on the WhatsApp Business app is Coexistence and is
 * not registered), subscribes our app to the WABA and stores the account with
 * the token sealed. Nothing is stored unless every Meta call answered.
 */

type SignupEnv = Pick<
  Env,
  | "WHATSAPP_APP_ID"
  | "WHATSAPP_APP_SECRET"
  | "WHATSAPP_SIGNUP_CONFIG_ID"
  | "CHANNEL_TOKEN_KEY"
>

const refuse = (
  status: number,
  cls: "provider" | "integrity" | "resource",
  code: string,
  message: string
) => failure(status, { class: cls, code, message, detail: {} })

const unavailable = () =>
  refuse(
    503,
    "provider",
    "channels.signup_unavailable",
    "WhatsApp sign-up is not set up yet."
  )

const asAccount = (row: typeof whatsappAccounts.$inferSelect) =>
  WhatsAppAccount.parse({
    display_number: row.displayNumber,
    display_name: row.displayName,
    source: row.source,
    coexistence: row.coexistence,
    status: row.status,
  })

/** One Graph call; null on any refusal or network failure, logged by step only (the URL can hold a secret). */
async function meta<T>(
  step: string,
  path: string,
  token?: string,
  body?: object
): Promise<T | null> {
  try {
    const response = await fetch(`${GRAPH}/${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        ...(token && { authorization: `Bearer ${token}` }),
        ...(body && { "content-type": "application/json" }),
      },
      ...(body && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    })
    if (response.ok) return (await response.json()) as T
    console.warn(
      JSON.stringify({
        code: "whatsapp.signup_step",
        step,
        status: response.status,
      })
    )
  } catch {
    console.warn(
      JSON.stringify({ code: "whatsapp.signup_step", step, status: 0 })
    )
  }
  return null
}

/**
 * The two-step PIN Meta wants at registration, derived from the number's id so
 * a later re-registration needs no stored secret. It changes only with
 * `CHANNEL_TOKEN_KEY`.
 */
async function pinOf(key: string, phoneNumberId: string): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    ),
    new TextEncoder().encode(`pin:${phoneNumberId}`)
  )
  return String(new DataView(mac).getUint32(0) % 1_000_000).padStart(6, "0")
}

/**
 * `GET /channels/whatsapp/signup` (what the popup needs) and
 * `POST /channels/whatsapp/signup` (what it returned). The caller has passed
 * the gate, the idempotency key and the owner check.
 */
export async function signupRoute(
  request: Request,
  env: SignupEnv,
  kit: Tenancy,
  owner: Owner
): Promise<Response> {
  const { WHATSAPP_APP_ID, WHATSAPP_APP_SECRET, CHANNEL_TOKEN_KEY } = env
  const configId = env.WHATSAPP_SIGNUP_CONFIG_ID
  if (
    !(WHATSAPP_APP_ID && WHATSAPP_APP_SECRET && CHANNEL_TOKEN_KEY && configId)
  ) {
    return unavailable()
  }
  if (request.method === "GET") {
    return Response.json({ app_id: WHATSAPP_APP_ID, config_id: configId })
  }

  const parsed = WhatsAppSignupComplete.safeParse(await readBody(request))
  if (!parsed.success) return invalid(parsed.error.issues)
  const { code, waba_id: wabaId, phone_number_id: phoneId } = parsed.data
  const { orgId } = owner

  const [own] = await kit.withOrg({ orgId }, (db) =>
    db.select().from(whatsappAccounts)
  )
  if (own && own.phoneNumberId !== phoneId) {
    return refuse(
      409,
      "integrity",
      "channels.account_exists",
      "This business already has a WhatsApp number."
    )
  }
  // The same popup result sent twice: the code is spent, the account is there.
  if (own?.status === "active") return Response.json(asAccount(own))
  const taken = await whatsAppAccountByPhone(kit, phoneId)
  if (taken && taken.orgId !== orgId) return numberTaken()

  const failed = () =>
    refuse(
      502,
      "provider",
      "channels.signup_failed",
      "WhatsApp did not finish the sign-up. Try again."
    )
  const exchanged = await meta<{ access_token?: string }>(
    "exchange",
    `oauth/access_token?${new URLSearchParams({
      client_id: WHATSAPP_APP_ID,
      client_secret: WHATSAPP_APP_SECRET,
      code,
    })}`
  )
  const token = exchanged?.access_token
  if (!token) return failed()
  // The ids came from the browser. Only a token that reaches this number reads it.
  const phone = await meta<{
    display_phone_number?: string
    verified_name?: string
    is_on_biz_app?: boolean
  }>(
    "phone",
    `${phoneId}?fields=display_phone_number,verified_name,is_on_biz_app`,
    token
  )
  if (!phone?.display_phone_number) return failed()
  const coexistence = phone.is_on_biz_app === true
  if (
    !(
      coexistence ||
      (await meta("register", `${phoneId}/register`, token, {
        messaging_product: "whatsapp",
        pin: await pinOf(CHANNEL_TOKEN_KEY, phoneId),
      }))
    ) ||
    !(await meta("subscribe", `${wabaId}/subscribed_apps`, token, {}))
  ) {
    return failed()
  }

  const displayNumber = `+${phone.display_phone_number.replace(/\D/g, "")}`
  const values = {
    wabaId,
    phoneNumberId: phoneId,
    displayNumber,
    displayName: (phone.verified_name || displayNumber).slice(0, 100),
    tokenCiphertext: await sealToken(env, orgId, token),
    source: "connected" as const,
    coexistence,
    status: "active" as const,
  }
  try {
    const [row] = await kit.withOrg({ orgId }, (db) =>
      db
        .insert(whatsappAccounts)
        .values({ orgId, ...values })
        .onConflictDoUpdate({
          target: whatsappAccounts.orgId,
          set: { ...values, updatedAt: new Date() },
        })
        .returning()
    )
    return Response.json(
      asAccount(row as typeof whatsappAccounts.$inferSelect),
      {
        status: 201,
      }
    )
  } catch (error) {
    // Two orgs racing for one number: the unique index decides.
    if (constraint(error).code === "23505") return numberTaken()
    throw error
  }
}

const numberTaken = () =>
  refuse(
    409,
    "integrity",
    "channels.number_taken",
    "That number is connected to another Reme business."
  )
