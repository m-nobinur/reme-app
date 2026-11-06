import type { Journey } from "@workspace/contracts"
import type { AskIntent } from "@workspace/ui/lib/activity-copy"

/** What a Connect in the stack says for the owner, and the skill its intent loads. */
export const CONNECT_ADDRESS = {
  ask: "Help me set up my domain",
  intent: "connect_address",
} as const
export const CONNECT_GOOGLE = {
  ask: "Help me connect Google Search Console",
  intent: "connect_google",
} as const

/** The update stack's own item for the website journey: the address, or Google once there is one. */
export type JourneyItem = {
  id: "address" | "google"
  title: string
  label: string
  ask: string
  intent: AskIntent
  /** Before the site card: a name the owner went to buy elsewhere, or one the registry shows they bought. */
  lead: boolean
}

/**
 * The journey's item in the update stack, read only from the journey the
 * workspace sends, so the stack, the draft-ready line and the assistant
 * agree. The address item stands wherever the journey offers a Connect
 * (`offer`, the draft-ready line's own rule) or the owner skipped it, once
 * there is a site to put it on (`site`: a draft on screen, or one ready or
 * live). Google follows once the address is connecting or live, or on the
 * site's free address once the owner skipped the address or turned it down,
 * until it is connected or turned down; only then does a skipped address
 * come back as Add your domain. A name the owner went to buy asks "Finished
 * buying?" only once they are `back` from its registrar link (`useBack`):
 * until then the chat already holds the question.
 */
export function journeyItem(
  journey: Journey | undefined,
  site: boolean,
  back = true
): JourneyItem | null {
  if (!journey) return null
  const { stage, name, offer } = journey.address
  const address = (title: string, label: string, lead = false) =>
    ({ id: "address", title, label, lead, ...CONNECT_ADDRESS }) as const
  if (stage === "buying_elsewhere" && name) {
    return back ? address(`Finished buying ${name}?`, "Connect it", true) : null
  }
  if (offer === "connect_bought" && name) {
    return address(`${name} is ready to connect`, "Connect", true)
  }
  const drawn =
    site || journey.website === "draft_ready" || journey.website === "published"
  if (drawn && offer) return address("Choose your domain", "Connect now")
  const free = drawn && (stage === "put_off" || stage === "declined")
  if (
    (stage === "connecting" || stage === "live" || free) &&
    journey.google !== "connected" &&
    journey.google !== "declined" &&
    journey.google !== "waiting_for_domain"
  ) {
    return {
      id: "google",
      title: "Get found on Google",
      label: "Connect Search Console",
      lead: false,
      ...CONNECT_GOOGLE,
    }
  }
  if (drawn && stage === "put_off") {
    return address("Add your domain", "Connect now")
  }
  return null
}

/**
 * The stack's order: a lead item first, then the site card, then what
 * waits in between (a new chat's questions, approvals and reminders), then
 * the journey's other item.
 */
export const stackOrder = <T>(
  item: { lead: boolean; value: T } | null,
  site: readonly T[],
  rest: readonly T[] = []
): T[] => [
  ...(item?.lead ? [item.value] : []),
  ...site,
  ...rest,
  ...(item && !item.lead ? [item.value] : []),
]
