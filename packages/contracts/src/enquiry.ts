import { z } from "zod"
import { Uuid } from "./common.ts"
import { Text } from "./text.ts"

/**
 * Where a built site's quote form posts, on the site's own host. The router
 * hands it to the Core API, which reads the org from that host.
 */
export const QUOTE_PATH = "/api/quote"

/** Where the API sends the visitor back to, on the same host: CSS `:target` shows the line. */
export const QUOTE_SENT_PATH = "/quote/#quote-sent"
export const QUOTE_NOT_SENT_PATH = "/quote/#quote-not-sent"

/** The honeypot a person never sees; a name no quote question can take. */
export const QUOTE_TRAP_FIELD = "_website"

export const ENQUIRY_PHOTOS_MAX = 5

/** One answer as the visitor gave it, under the question's label. */
export const EnquiryAnswer = z.strictObject({
  label: Text(200),
  value: Text(2000),
})

/**
 * A quote request from the business's website. Every word is the visitor's,
 * so it is untrusted input wherever it goes. `photos` are ids the owner's
 * `/photos/{id}` serves.
 */
export const Enquiry = z.strictObject({
  id: Uuid,
  name: Text(200),
  email: z.email().max(254),
  phone: Text(40).optional(),
  answers: z.array(EnquiryAnswer).max(30),
  photos: z.array(Uuid).max(ENQUIRY_PHOTOS_MAX),
})

/** How an `Enquiry` is stored among a message's parts: an AI SDK data part. */
export const EnquiryPart = z.strictObject({
  type: z.literal("data-enquiry"),
  data: Enquiry,
})

export type EnquiryAnswer = z.infer<typeof EnquiryAnswer>
export type Enquiry = z.infer<typeof Enquiry>
export type EnquiryPart = z.infer<typeof EnquiryPart>
