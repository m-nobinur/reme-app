import {
  type ChannelLink,
  ChannelLinkStarted,
  ChannelsState,
  type WhatsAppAccount,
} from "@workspace/contracts"

/** `packages/contracts/test/samples.ts` values, parsed, so a drifted fixture fails its own test. */
const LATER = "2026-11-07T10:00:00.000Z"

export const ACCOUNT: WhatsAppAccount = {
  display_number: "+447700900123",
  display_name: "Sparkle Cleaning",
  source: "connected",
  coexistence: true,
  status: "active",
}

export const LINK: ChannelLink = {
  id: "8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0d1e",
  kind: "whatsapp",
  label: "+44 7•••• ••1234",
  connected_at: LATER,
  updates: true,
}

export const stateOf = (
  whatsapp: Partial<ChannelsState["whatsapp"]> = {}
): ChannelsState =>
  ChannelsState.parse({
    whatsapp: { available: true, account: ACCOUNT, links: [LINK], ...whatsapp },
  })

export const STARTED = ChannelLinkStarted.parse({
  kind: "whatsapp",
  url: "https://wa.me/447700900123?text=Connect%20Reme%20Jb3k9QwXz1mP0aRtYc7Vn5HgLd2UeSfI",
  expires_at: "2026-11-07T10:10:00.000Z",
})
