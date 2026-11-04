import { IndustryId, type ServerButton } from "@workspace/contracts"
import { currentFacts, type Tenancy } from "@workspace/db"
import type { Update } from "./heartbeat-write.ts"

/**
 * What the owner hears about their own web address and Google, by moment:
 * each a template (what they read when the model's words cannot be trusted)
 * and a brief (what the moment is for, so the model's words name the same
 * benefit). The voice rules every brief shares are in `writeUpdate`'s prompt.
 */

/** The business as the facts hold it, for the briefs; any of it may be missing. */
export type About = {
  business?: string
  trade?: string
  category?: IndustryId
  area?: string
}

const text = (v: unknown, key: string) => {
  const found = (v as Record<string, unknown> | undefined)?.[key]
  return typeof found === "string" && found.trim() ? found.trim() : undefined
}

/** The business's name, trade and area from the current facts. */
export async function aboutOf(kit: Tenancy, orgId: string): Promise<About> {
  const rows = await kit.withOrg({ orgId }, currentFacts)
  const value = (key: string) => rows.find((r) => r.key === key)?.value
  const business = text(value("business.name"), "name")
  const trade = text(value("business.industry"), "name")
  const category = IndustryId.safeParse(
    text(value("business.industry"), "category")
  ).data
  const area =
    text(value("service_area.radius"), "centre") ??
    text(value("service_area.text"), "text")
  return {
    ...(business && { business }),
    ...(trade && { trade }),
    ...(category && { category }),
    ...(area && { area }),
  }
}

const context = ({ business, trade, area }: About) => {
  const bits = [
    business,
    trade && `a ${trade.toLowerCase()} business`,
    area && `serving ${area}`,
  ].filter(Boolean)
  return bits.length > 0 ? `About the business: ${bits.join(", ")}. ` : ""
}

const nameFact = (about: About): Record<string, string> =>
  about.business ? { business: about.business } : {}

/** The button the live messages open the website with. */
export const VISIT = "Visit your website"

/** Google's own sign-in, one tap from a message. */
export const CONNECT_GOOGLE: ServerButton = {
  label: "Connect Google",
  action: { kind: "connect", service: "google" },
}

/** A, when the business email already runs on a domain of the owner's own. */
export const addressOfferOwn = (address: string, about: About): Update => ({
  facts: { address },
  template: `While I put your website together: your email runs on ${address}, so you already own the right address for it. Customers who've emailed you will recognise it, and Google will tie your website to the name you've used all along. Shall I put it there, so it goes live on it the moment you publish?`,
  brief: `${context(about)}The first website build has just started, and the owner's email runs on their own domain. Offer to put the website there: customers who've emailed them will recognise it, and Google ties the website to the name they already use. End by asking whether to put it there; a button answers it, so don't mention one.`,
})

/** E: the owner's setting is in and the padlock is on its way; Google is not connected yet. */
export const googleOffer = (domain: string, about: About): Update => ({
  facts: { domain },
  template: `Your setting's in, so ${domain} just needs its security padlock now, which usually takes a few minutes. While that happens, let me connect your website to Google: once it's live I'll add it and send over every page, so people searching for what you do${about.area ? ` around ${about.area}` : ""} can start finding you, and I'll tell you how many see you there. It's one sign-in with your Google account, and I'll do the rest.`,
  brief: `${context(about)}The owner just added the setting for their domain; only the security padlock is left, which takes minutes. Say that, then offer to connect their website to Google while they wait: once it's live you add it and send Google every page, so people nearby searching for what they do can find them, and you tell them how many see them in search. It takes one sign-in to their Google account. Never promise a ranking or a date.`,
})

/** The setting is in and Google is connected or settled: only the padlock is left. */
export const padlockLine = (domain: string) =>
  `Your setting for ${domain} is in, so it just needs its security padlock now, which usually takes a few minutes.`

/** G: the first version is live and nothing about the address is outstanding. */
export const liveOffer = (about: About): Update => ({
  facts: {},
  template: `Congratulations, your website is live. Customers can now find you online and ask for a quote at any time. You can view it with the ${VISIT} button, or ask me to open it.`,
  brief: `${context(about)}The owner's first website has just gone live. Congratulate them once, then say what it does for them now: customers can find the business online and ask for a quote at any time, and quote requests come straight to you. End by saying they can have a look now, or offering to open it for them.`,
})

/** G, with the owner's own address one step from taking over: the padlock is on its way. */
export const livePadlock = (domain: string, about: About): Update => ({
  facts: { domain },
  template: `Congratulations, your website is live! It's on its free address for a few more minutes while ${domain} gets its security padlock, then your own address takes over by itself. You can share either link; both will keep working.`,
  brief: `${context(about)}The owner's first website has just gone live on its free address; their own domain takes over by itself in a few minutes, once its security padlock is ready. Congratulate them once, say that, and that any link they share keeps working.`,
})

/** G, with the owner's setting not in yet, or held back until now because their current site lives on the name. */
export const liveSettingDue = (domain: string, about: About): Update => ({
  facts: { domain },
  template: `Congratulations, your website is live. Now's the moment to add the setting for ${domain}: once it's in, your own address takes over from the free one by itself, and every link you've shared keeps working. Tap the button and I'll show you the setting again.`,
  brief: `${context(about)}The owner's first website has just gone live on its free address. Their own domain is waiting for one setting, which may have waited on purpose until now so their current website stayed up. Congratulate them once, say now is the time to add it, that their own address then takes over by itself, and that the button shows the setting again.`,
})

/** G, when the claim on the owner's name lapsed before the publish: the steps come back with a button. */
export const liveSettingLapsed = (domain: string, about: About): Update => ({
  facts: { domain },
  template: `Congratulations, your website is live. ${domain} wasn't connected in time, so I let it go for now, but it only takes a couple of minutes to set up again, and then your own address takes over from the free one. Tap the button and I'll bring the setting back.`,
  brief: `${context(about)}The owner's first website has just gone live on its free address. Their own domain was not connected in time, so it was let go for now. Congratulate them once, say it takes a couple of minutes to set up again so their own address takes over, and that the button brings the setting back.`,
})

/** H2: the owner said no to an address of their own; Google can still find the free one. */
export const liveGoogleOffer = (about: About): Update => ({
  facts: {},
  template: `Congratulations, your website is live! Next, let's make sure people can find it: connect your Google account and I'll add your website to Google, send over every page and tell you how many people see you in search. It's one sign-in, and I'll do the rest.`,
  brief: `${context(about)}The owner's first website has just gone live on its free address; they chose not to use a domain of their own. Congratulate them once, then offer to connect their website to Google so people searching for what they do can find it: you add it, send Google every page and tell them how many see them in search. It takes one sign-in to their Google account. Never promise a ranking or a date.`,
})

/** G, when the owner's email names a domain of their own and no address was offered during the build. */
export const liveOwnAddress = (address: string, about: About): Update => ({
  facts: { address },
  template: `Congratulations, your website is live. Your email runs on ${address}, so you already own the right address for it: customers who've emailed you will recognise it, and Google will tie your website to the name you've used all along. Shall I put it there?`,
  brief: `${context(about)}The owner's first website has just gone live on its free address, and their email runs on their own domain. Congratulate them once, then offer to put the website on that domain: customers who've emailed them will recognise it, and Google ties the website to the name they already use. End by asking; a button answers it, so don't mention one.`,
})

/** G, asking about an address once more (put off during the build), or for the first time when the build's offer never landed. */
export const liveAddressAgain = (about: About): Update => ({
  facts: {},
  template: `Congratulations, your website is live. Customers can now find you online and ask for a quote at any time. Whenever you're ready for an address of your own, it takes a couple of minutes and customers trust it more than the free one.`,
  brief: `${context(about)}The owner's first website has just gone live. Congratulate them once and say customers can now find them and ask for a quote. They put off choosing their own web address earlier: mention it once more, lightly, with its benefit (customers trust it more than the free one). Never push, and say nothing of the card that asks.`,
})

/** The launch on the owner's own address: it was ready and went live with the first publish. */
export const liveOnDomain = (
  host: string,
  about: About,
  google: boolean
): Update => ({
  facts: { host, ...nameFact(about) },
  template: `Congratulations, ${about.business ?? "your website"} is live on ${host}! Customers can now see your services and ask for a quote at any time. You can view it with the ${VISIT} button${google ? ", and I'm adding it to Google now" : ", or ask me to open it"}.`,
  brief: `${context(about)}The owner's first website has just gone live on their own domain. Congratulate them once, say customers can now see their services and ask for a quote at any time, and offer to open it for them.${google ? " Say you are adding it to Google now and will tell them once it's in." : ""}`,
})

/** H: the owner's own address takes over from the free one on a website already live. */
export const domainTakesOver = (
  host: string,
  about: About,
  google: boolean,
  replaced?: string
): Update => ({
  facts: { host, ...(replaced && { replaced_domain: replaced }) },
  template: `${host} is now live! That's the address to put on your cards and quotes from today, and anyone using the old link lands on the new one, so nothing you've shared is lost.${replaced ? ` ${replaced} isn't used any more, so its setting can be deleted.` : google ? " I'm adding it to Google too and will tell you once it's in." : ""}`,
  brief: `${context(about)}The owner's own domain has just taken over from the free address on their live website. Say so, that it is the address for their cards and quotes from today, and that old links still land on it.${replaced ? " The domain it replaced is no longer used, so its setting can be deleted." : google ? " Say you are adding it to Google too." : ""}`,
})

/** I: the website is in the owner's Search Console with every page sent. */
export const onGoogle = (host: string, about: About): Update => ({
  facts: { host },
  template: `Google now knows about ${host}, and I've sent it every page on your website. New websites usually take a few days to a few weeks to start showing in search, and I'll tell you how it's doing as people find you.`,
  brief: `${context(about)}The owner's website has just been added to Google with every page sent. Say so plainly, that new websites usually take days to a few weeks to show in search, and that you will tell them how it does. Never promise a ranking, a position or a date.`,
})
