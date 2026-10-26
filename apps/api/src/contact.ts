/** Tracing a contact detail a model proposed back to what the owner typed. */

import { toE164 } from "@workspace/contracts"

/** Runs in the owner's words that could be a phone number. */
const TYPED_PHONE = /\+?\d[\d\s().-]{5,}\d/g

/**
 * Whether an E.164 number is exactly one the owner typed, read for their
 * country: "00195 899933" is +1 and cannot be dialled, so no number a
 * model reads into it, such as +44 0195 899933, is theirs.
 */
export const phoneFromOwner = (e164: string, said: string) =>
  (said.match(TYPED_PHONE) ?? []).some((typed) => toE164(typed) === e164)

/** Whether an address appears in what the owner typed. */
export const emailFromOwner = (address: string, said: string) =>
  said.toLowerCase().includes(address.toLowerCase())
