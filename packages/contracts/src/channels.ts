import { z } from "zod"
import { Timestamp, Uuid } from "./common.ts"
import { E164 } from "./owner.ts"
import { Text } from "./text.ts"

/** Where an owner can chat with their assistant besides the web. */
export const ChannelKind = z.enum(["whatsapp", "telegram"])

/** Meta's ids (WABA, phone number) are digit strings. */
const MetaId = z.string().regex(/^\d{1,32}$/)

/** One owner's personal chat linked to the org. `label` is a masked number. */
export const ChannelLink = z.strictObject({
  id: Uuid,
  kind: ChannelKind,
  label: Text(40),
  connected_at: Timestamp,
  updates: z.boolean(),
})

/**
 * The business's WhatsApp number. `source` is how it got here (`dev` is the
 * test number a script writes); `coexistence` is a number the business also
 * uses in the WhatsApp Business app.
 */
export const WhatsAppAccount = z.strictObject({
  display_number: E164,
  display_name: Text(100),
  source: z.enum(["connected", "purchased", "dev"]),
  coexistence: z.boolean(),
  status: z.enum(["pending", "active", "disabled"]),
})

/**
 * `GET /channels`. `available` is false while the gate is off, and the web
 * then hides the section.
 */
export const ChannelsState = z.strictObject({
  whatsapp: z.strictObject({
    available: z.boolean(),
    account: WhatsAppAccount.nullable(),
    links: z.array(ChannelLink).max(20),
  }),
})

/** `POST /channels/whatsapp/link`: the `wa.me` link carrying the one-time code. */
export const ChannelLinkStarted = z.strictObject({
  kind: ChannelKind,
  url: z
    .string()
    .regex(/^https:\/\/\S+$/)
    .max(2000),
  expires_at: Timestamp,
})

/** `PATCH /channels/links/{id}`: send updates to this chat, or stop. */
export const ChannelLinkPatch = z.strictObject({ updates: z.boolean() })

/** `POST /channels/whatsapp/signup`: what Meta's Embedded Signup popup returned. */
export const WhatsAppSignupComplete = z.strictObject({
  code: z.string().min(1).max(2000),
  waba_id: MetaId,
  phone_number_id: MetaId,
})

/** `POST /channels/whatsapp/numbers/search`: UK mobile numbers only. */
export const NumberSearch = z.strictObject({
  contains: z
    .string()
    .regex(/^\d{1,8}$/)
    .optional(),
})

/** A number the owner can buy. UK mobiles have no locality, so it may be null. */
export const NumberOffer = z.strictObject({
  phone_number: E164,
  locality: Text(80).nullable(),
})

/** `POST /channels/whatsapp/numbers`: the details Twilio's UK bundle needs. */
export const NumberPurchase = z.strictObject({
  phone_number: z.string().regex(/^\+447\d{9}$/),
  business_name: Text(100),
  address_line_1: Text(100),
  address_line_2: Text(100).optional(),
  city: Text(60),
  postcode: z.string().regex(/^[A-Za-z]{1,2}\d[A-Za-z\d]? ?\d[A-Za-z]{2}$/),
  contact_name: Text(100),
  email: z
    .string()
    .max(254)
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
})

/** Where a purchase stands: Twilio reviews the bundle before the number is bought. */
export const NumberPurchaseState = z.strictObject({
  state: z.enum(["pending_review", "approved", "rejected", "ready"]),
})

export type ChannelKind = z.infer<typeof ChannelKind>
export type ChannelLink = z.infer<typeof ChannelLink>
export type WhatsAppAccount = z.infer<typeof WhatsAppAccount>
export type ChannelsState = z.infer<typeof ChannelsState>
export type ChannelLinkStarted = z.infer<typeof ChannelLinkStarted>
export type ChannelLinkPatch = z.infer<typeof ChannelLinkPatch>
export type WhatsAppSignupComplete = z.infer<typeof WhatsAppSignupComplete>
export type NumberSearch = z.infer<typeof NumberSearch>
export type NumberOffer = z.infer<typeof NumberOffer>
export type NumberPurchase = z.infer<typeof NumberPurchase>
export type NumberPurchaseState = z.infer<typeof NumberPurchaseState>
