import { describe, expect, it } from "vitest"
import {
  ChannelLinkPatch,
  ChannelLinkStarted,
  NumberPurchase,
  NumberPurchaseState,
  WhatsAppSignupComplete,
} from "../src/channels.ts"
import { ConversationMessage } from "../src/conversation.ts"
import { ajv, generated } from "./json-schema.ts"
import { samples } from "./samples.ts"

const verdict = (
  name: string,
  schema: { safeParse: (v: unknown) => { success: boolean } },
  value: unknown
) => ({
  zod: schema.safeParse(value).success,
  json: ajv.validate(generated.components.schemas[name] as object, value),
})
const REFUSED = { zod: false, json: false }
const ACCEPTED = { zod: true, json: true }

const purchase = samples.NumberPurchase as Record<string, unknown>
const message = samples.ConversationMessage as {
  content: { metadata: { custom: Record<string, unknown> } }
}

describe("NumberPurchase", () => {
  it.each([
    ["a US number", { phone_number: "+12025550123" }],
    ["a UK landline", { phone_number: "+441134960000" }],
    ["a malformed postcode", { postcode: "12345" }],
    ["a blank business name", { business_name: "  " }],
    ["an email with no domain", { email: "sam@" }],
  ])("refuses %s", (_name, change) => {
    expect(
      verdict("NumberPurchase", NumberPurchase, { ...purchase, ...change })
    ).toEqual(REFUSED)
  })

  it("takes a postcode without the space", () => {
    expect(
      verdict("NumberPurchase", NumberPurchase, {
        ...purchase,
        postcode: "LS14AP",
      })
    ).toEqual(ACCEPTED)
  })
})

describe("the rest of the channel shapes", () => {
  it.each([
    ["ChannelLinkPatch", ChannelLinkPatch, {}],
    ["ChannelLinkPatch", ChannelLinkPatch, { updates: "yes" }],
    [
      "ChannelLinkStarted",
      ChannelLinkStarted,
      { ...(samples.ChannelLinkStarted as object), url: "http://wa.me/1" },
    ],
    [
      "WhatsAppSignupComplete",
      WhatsAppSignupComplete,
      { ...(samples.WhatsAppSignupComplete as object), waba_id: "abc" },
    ],
    ["NumberPurchaseState", NumberPurchaseState, { state: "bought" }],
  ])("%s refuses a bad value", (name, schema, value) => {
    expect(verdict(name, schema, value)).toEqual(REFUSED)
  })
})

describe("message source", () => {
  const withSource = (source: unknown) => ({
    ...message,
    content: {
      ...message.content,
      metadata: { custom: { ...message.content.metadata.custom, source } },
    },
  })

  it("takes a channel kind", () => {
    expect(
      verdict(
        "ConversationMessage",
        ConversationMessage,
        withSource("whatsapp")
      )
    ).toEqual(ACCEPTED)
  })

  it("refuses any other source", () => {
    expect(
      verdict("ConversationMessage", ConversationMessage, withSource("sms"))
    ).toEqual(REFUSED)
  })
})
