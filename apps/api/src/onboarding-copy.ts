import type { IndustryId, PronounId, ToneId } from "@workspace/contracts"
import type { StepId } from "./onboarding.ts"

/**
 * Every line the onboarding script says. Pure functions of what the owner
 * has told us so far. Most lines come in two or three wordings, picked by a
 * hash of the org id and the line's name, so two owners do not read the same
 * template and a reload never changes what one owner reads. The owner never
 * sees a price or a tier here.
 */

export type Voice = {
  /** The org id: it picks each line's wording. */
  org: string
  business: string
  /** What the assistant calls the owner, or "" before it knows. */
  owner: string
  /** The assistant's name, or "" before the owner chose one. */
  assistant: string
  pronouns: PronounId
  tone: ToneId
  industry: { name: string; category: IndustryId | null } | null
  /** The first service the owner listed, in their words. */
  offering: string | null
  /** The preset labels the owner picked, or null for their own words. */
  template: string | null
  palette: string | null
}

/** FNV-1a over UTF-16 units: stable across isolates and deploys. */
function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/** One of `wordings`, the same one for this org every time. */
const pick = <T>(v: Voice, line: string, wordings: readonly T[]): T =>
  wordings[hash(`${v.org}|${line}`) % wordings.length] as T

/** Lower-cases a leading capital unless the word is an acronym. */
const lower = (text: string) =>
  /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** ", Sam" when the owner's name is known. */
const comma = (name: string) => (name ? `, ${name}` : "")

/**
 * What each tone changes in the friendly copy. Professional drops
 * exclamation marks and contractions; casual goes the other way and trims a
 * few stiff openings. A small table, not three copies of every line.
 */
const TONE: Record<ToneId, [RegExp, string][]> = {
  friendly: [],
  professional: [
    [/!/g, "."],
    [/\bno worries at all\b/gi, "that is fine"],
    [/\bgreat pick\b/gi, "a good choice"],
    [/\blovely\b/gi, "thank you"],
    [/\bbrilliant\b/gi, "very good"],
    [/\bI'm\b/g, "I am"],
    [/\bI'll\b/g, "I will"],
    [/\bI'd\b/g, "I would"],
    [/\bI've\b/g, "I have"],
    [/\bwe'll\b/gi, "we will"],
    [/\byou'll\b/gi, "you will"],
    [/\byou'd\b/gi, "you would"],
    [/\byou're\b/gi, "you are"],
    [/\bdon't\b/gi, "do not"],
    [/\bcouldn't\b/gi, "could not"],
    [/\bshouldn't\b/gi, "should not"],
    [/\bcan't\b/gi, "cannot"],
    [/\bisn't\b/gi, "is not"],
    [/\bit's\b/gi, "it is"],
    [/\bthat's\b/gi, "that is"],
    [/\bwhat's\b/gi, "what is"],
    [/\bthere's\b/gi, "there is"],
  ],
  casual: [
    [/\bWould you like\b/g, "Want"],
    [/\bthank you\b/gi, "thanks"],
    [/\bcould you\b/gi, "can you"],
    [/\bperfect\b/gi, "nice"],
    [/\bwonderful\b/gi, "nice"],
    [/\bI will\b/g, "I'll"],
    [/\bdo not\b/gi, "don't"],
  ],
}

/** `text` in the owner's chosen tone, a capital kept where the words began with one. */
export function say(v: Pick<Voice, "tone">, text: string): string {
  return TONE[v.tone].reduce(
    (out, [pattern, to]) =>
      out.replace(pattern, (found) =>
        found.charAt(0) !== found.charAt(0).toLowerCase() ? capital(to) : to
      ),
    text
  )
}

/** The owner's three openers, with the business's name in each. */
export function opener(v: Voice): string {
  return say(
    v,
    pick(v, "opener", [
      `Welcome! It's great to have you here. Building a strong online presence for ${v.business} shouldn't feel complicated or overwhelming, so think of this as a relaxed chat over coffee.

I'll ask a few quick questions so I can understand your business and goals, and then we'll bring everything together into a website made for you.`,
      `Hello and welcome! I'm so excited to work together on the new website for ${v.business}.

Before we get into the design, I'd love to learn a little about what you do, who your ideal clients are and how you operate. No forms or tests here, just tell me in your own words.`,
      `Hi there, welcome aboard! My goal today is to take the hassle out of getting ${v.business} online.

In just a few short minutes, we'll talk through what your business does and how you want your site to look. Then I'll handle the heavy lifting of building it.`,
    ])
  )
}

type Asked = Exclude<StepId, "upload" | "build">

const QUESTIONS: Record<Asked, (v: Voice) => string[]> = {
  "business.name": () => [
    "Before anything else, what's your business called, as you'd like customers to see it?",
    "First, what name should customers know your business by?",
  ],
  industry: (v) => [
    `To start, what kind of business is ${v.business}?`,
    `First things first. Which of these comes closest to what ${v.business} does?`,
  ],
  "business.offerings": (v) => [
    `Lovely. What are the main services or products ${v.business} offers? The ones customers ask for most are a good place to start.`,
    `Thanks. What do people come to ${v.business} for? A short list is plenty.`,
  ],
  "business.audience": (v) => [
    v.offering
      ? `Got it. Who are your ideal customers, the people you'd most like to see asking about ${lower(v.offering)}?`
      : "Got it. Who are your ideal customers, the people you'd most like to hear from?",
    "Thanks, that's useful. Who do you most enjoy working for? The site will speak to them first.",
  ],
  "business.overview": () => [
    "That helps a lot. How do you usually work with a customer, from their first message onwards? A few sentences in your own words is plenty.",
    "Good to know. What happens after someone gets in touch with you?",
  ],
  "service_area.text": (v) => [
    `Which areas does ${v.business} serve? A few towns, some neighbourhoods or a rough distance all work.`,
    "And where do your customers come from? A few towns or areas, or a rough distance from you, is plenty.",
  ],
  "business.phone": () => [
    "Perfect. What's the best phone number for customers to reach you on?",
    "Now the practical bits. Which number should customers call?",
  ],
  "business.email": () => [
    "And which email address should enquiries go to?",
    "Which email address do you check most for new enquiries?",
  ],
  "business.tagline": (v) => [
    "Last one about the business. Do you have a slogan or tagline you like to use? It's fine to skip this one.",
    `One more before we move on. Is there a short line you use to sum up ${v.business}? If not, you can skip it.`,
  ],
  // Phase 1 to 2: what they told us, then the working relationship.
  "assistant.name": (v) => [
    `Thank you! That gives me a really clear picture of what ${v.business} is all about. Now that I know who you are and what you offer, let's make our partnership official.

Before we start designing, let's settle how I introduce myself to you and your visitors. What name would you like to give me?`,
    `That's everything I need to know about ${v.business} for now, thank you. I can already picture how the site should read.

Now a little about me. I'll be the one looking after your enquiries and keeping you posted, so I should have a name you like. What would you like to call me?`,
    `Thanks${comma(v.owner)}. I have a good picture of ${v.business} now, and a few ideas for the site already.

Before we get to the website, let's make this partnership official. What name should I go by?`,
  ],
  pronouns: (v) =>
    v.assistant
      ? [
          `${v.assistant} it is, I like it! Which pronouns should I go by?`,
          `${v.assistant}. That has a nice ring to it. Which pronouns suit me best?`,
        ]
      : ["Which pronouns should I go by?"],
  tone: () => [
    "And what kind of personality would you like me to have when I talk to you and your customers?",
    "How should I come across when I talk to your customers?",
  ],
  "owner.preferred_name": (v) => [
    `What should ${v.assistant || "I"} call you?`,
    "And what would you like me to call you?",
  ],
  // Phase 2 to 3: the new identity, then the website and the quote page.
  build_for_me: (v) => {
    const me = v.assistant || "me"
    const ask = `Would you like ${me} to build your website for you? I can have a first draft ready while we keep chatting.`
    const call = v.assistant ? ` Call me ${v.assistant}.` : ""
    return [
      `It's an honour to officially be on the team${comma(v.owner)}!${call}

Now, let's turn our attention to your digital storefront. Every growing business needs a website that turns visitors into real enquiries, so yours will have a Request a quote page where customers can tell you exactly what they need.

${ask}`,
      `Lovely to meet you properly${comma(v.owner)}.${v.assistant ? ` I'm ${v.assistant}, and` : " I'm"} glad to be on board.

Let's talk about your website. It's often the first thing a new customer sees of ${v.business}, so getting in touch has to be easy. Every page will point visitors to Request a quote, and each enquiry will arrive with the details you need to reply.

${ask}`,
      `Thanks${comma(v.owner)}.${v.assistant ? ` ${v.assistant}, reporting for duty!` : ""}

Next is the part most owners put off, the website. A good one turns visitors into real enquiries, and yours will have a Request a quote page so customers can say what they need and you can reply with the right quote.

${ask}`,
    ]
  },
  manual_builder: (v) => [
    `No problem${comma(v.owner)}. Would you like to build the website yourself with the website builder instead?`,
    `That's fine${comma(v.owner)}. Would you rather put the website together yourself in the builder?`,
  ],
  template: (v) => [
    `Wonderful, let's design it together. First, the layout. Which of these feels most like ${v.business}?`,
    `Brilliant. We'll start with the overall layout. Which one suits ${v.business} best?`,
  ],
  palette: (v) => [
    v.template
      ? `${v.template} is a great choice. Which colours feel right for ${v.business}?`
      : `Thanks, I'll keep your notes in mind. Which colours feel right for ${v.business}?`,
    `${v.template ? "Good pick" : "Noted"}. Now for colour. Which of these palettes fits ${v.business}?`,
  ],
  font: () => [
    "And which style of lettering suits your brand?",
    "Now the lettering. Which of these feels most like you?",
  ],
  pages: () => [
    "Nearly there. Which pages should the site have? I've ticked the ones most businesses start with.",
    "Last design question. Which pages do you want? The usual ones are already ticked.",
  ],
}

/** The step's question, with the phase transition for a step that opens a phase. */
export function question(step: Asked, v: Voice): string {
  return say(v, pick(v, step, QUESTIONS[step](v)))
}

/**
 * The photo question, three ways per industry. Chauffeur and legal are the
 * owner's own lines, made to fit any firm in the category; the rest follow
 * their voice: a specific question, then why it matters.
 */
type Photos = ((v: Voice) => string)[]

/** Words that name a place: "your tattoo studio" reads, "your work in" does not. */
const PLACE =
  /^(?:studio|shop|salon|clinic|garage|gym|caf[eé]|bakery|school|centre|center|practice|agency|store|bar|restaurant|parlou?r|surgery|kitchen|workshop|boutique|hotel|nursery|kennels?|cattery|farm|brewery|gallery|venue|lab|truck)$/i
/** Words that name a person, so "your work as a funeral director". */
const PERSON =
  /(?:er|or|ist|ian|ant|agent|smith|dj|sweep|chef|cook|guide|vet|nurse|doula|midwife|coach)(?:e?s)?$/i
/** Words that end like a person and are not one. */
const THING =
  /^(?:flower|power|water|paper|timber|leather|rubber|computer|trailer|container|poster|shower|tower|boiler|mirror|door|floor|interior|exterior|decor)s?$/i

/**
 * The owner's own words for their industry, as a phrase that follows
 * "photos of": "your work in drone photography", "your work as a funeral
 * director", "your tattoo studio", "your wedding flowers". Title-cased words
 * are lower-cased, acronyms kept, and a trailing "business" or "company"
 * dropped.
 * ponytail: a suffix heuristic over the last word; an odd noun can still
 * read stiffly, never ungrammatically enough to name the wrong thing.
 */
export function yourWork(v: Pick<Voice, "industry">): string {
  const words = (v.industry?.name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (/^\p{Lu}[\p{Ll}'-]*$/u.test(w) ? w.toLowerCase() : w))
  while (
    words.length > 1 &&
    /^(?:business|company|firm|ltd|limited)\.?$/i.test(words.at(-1) ?? "")
  ) {
    words.pop()
  }
  const last = words.at(-1)
  if (!last || /^(?:business|company|work)$/i.test(last)) return "your work"
  const phrase = words.join(" ")
  if (PLACE.test(last)) return `your ${phrase}`
  if (PERSON.test(last) && !THING.test(last)) {
    const one = phrase.replace(/(?:(?<=ch|sh)es|(?<=[a-z]|[A-Z]{2})s)$/, "")
    const an = /^(?:[aeio]|u(?!ni|s[eu])|[AEFHILMNORSX][A-Z])/.test(one)
    return `your work as ${an ? "an" : "a"} ${one}`
  }
  if (/[^su]s$/i.test(last)) return `your ${phrase}`
  return `your work in ${phrase}`
}

const PHOTOS: Record<IndustryId, Photos> = {
  chauffeur: [
    () =>
      "Do you have any photos of your fleet, like exterior shots of the vehicles, interior luxury features, or your chauffeurs in uniform? Showing off your cars is the best way to help clients picture their ride.",
    () =>
      "Do you have photos of your cars in action, for example, at weddings, corporate events, or airport pickups? Real shots of your vehicles make a huge impression on visitors.",
    () =>
      "Do you have a few photos of your vehicles, both inside and outside? We can feature your best fleet photos right on the homepage to highlight the luxury experience.",
  ],
  legal: [
    () =>
      "People bring you things that matter deeply to them, so clients really connect with familiar, approachable faces. Do you have a professional headshot, a photo of your team, or your office space that we could feature?",
    () =>
      "Do you have high-resolution photos of yourself or your practice, or any association badges and certifications? Adding these helps build immediate confidence and trust with prospective clients.",
    () =>
      "Do you have a welcoming portrait of yourself or a photo of your consultation office? Having a friendly, professional face on the website helps put clients at ease from their very first visit.",
  ],
  cleaning: [
    (v) =>
      `Do you have any photos of your work, like a sparkling kitchen, a fresh bathroom or a before and after of a deep clean? Real results show visitors the difference ${v.business} makes better than anything we could write.`,
    () =>
      "Do you have photos of your team at work, in uniform or with your equipment? People are inviting you into their home, so friendly, professional faces help them book with confidence.",
    () =>
      "Do you have a few before and after shots of your cleans? We can feature the best ones right on the homepage to show your standard at a glance.",
  ],
  health: [
    () =>
      "Do you have a photo of yourself or your team, and one of the room where you see clients? People feel much more at ease booking when they know who they'll be seeing, and where.",
    () =>
      "Do you have professional photos of your practice, or any qualifications and memberships you'd like to show? They help new clients feel confident before their first appointment.",
    () =>
      "Do you have a friendly portrait of yourself or a photo of your treatment room? A real face on the homepage makes that first booking much easier.",
  ],
  beauty: [
    () =>
      "Do you have photos of your work, like finished looks, nails or styles you're proud of? Real results are the first thing new clients look for, and they show your skill better than words can.",
    () =>
      "Do you have photos of your salon or treatment rooms, maybe set up for a wedding party or a special occasion? Seeing the space helps clients picture their visit before they book.",
    () =>
      "Do you have a few before and after shots? We can make them the centrepiece of your gallery.",
  ],
  food: [
    (v) =>
      `Do you have photos of your food, like your signature dishes${v.offering ? ` or ${lower(v.offering)}` : ""}? Good food photos do more to bring people through the door than any description.`,
    () =>
      "Do you have photos of your place set up for service, or for events and private bookings? Real shots of the room help guests picture their visit.",
    () =>
      "Do you have a few shots of your best dishes? We can put them front and centre on the homepage.",
  ],
  trades: [
    () =>
      "Do you have photos of jobs you've finished, ideally a before and an after? Real projects show the quality of your work better than anything we could write.",
    () =>
      "Do you have photos of you or your team on site, your van, or any accreditations and trade memberships? They reassure customers about who will be turning up.",
    () =>
      "Do you have a few photos of your best work? We can build a project gallery from them.",
  ],
  property: [
    () =>
      "Do you have photos of properties you've sold, let or managed? Good property photos are what buyers and tenants click on first.",
    () =>
      "Do you have a professional photo of yourself, your team or your office? People trust you with one of their biggest decisions, so a friendly face goes a long way.",
    () =>
      "Do you have a few of your best property shots? We can feature them on the homepage to show the kind of homes you handle.",
  ],
  automotive: [
    () =>
      "Do you have photos of cars you've worked on, like a repair, a service or a before and after of a valet? Real results show visitors the standard of your work better than anything we could write.",
    () =>
      "Do you have photos of your workshop, your team or your equipment? Drivers are trusting you with their car, so seeing a tidy workshop and the people in it helps them book with confidence.",
    () =>
      "Do you have a few shots of your best work? We can put them on the homepage so visitors see the finish before they get in touch.",
  ],
  education: [
    () =>
      "Do you have a photo of yourself, or of a lesson or session in progress? People want to know who they'll be learning from, and a friendly face makes the first step easier.",
    () =>
      "Do you have photos of where you teach, or any qualifications and memberships you'd like to show? They help people feel confident before their first session.",
    () =>
      "Do you have a welcoming portrait of yourself? It makes the site feel personal from the very first visit.",
  ],
  events: [
    () =>
      "Do you have photos from events you've worked, like weddings, parties or corporate nights? Real shots from the day help people picture you at theirs.",
    () =>
      "Do you have photos of you or your team at work, or of your setup before the guests arrive? People planning a big day want to see who will be there and how it will look.",
    () =>
      "Do you have a few favourite shots from past events? We can build the homepage around them.",
  ],
  retail: [
    (v) =>
      `Do you have photos of your products${v.offering ? `, like ${lower(v.offering)}` : ""}, ideally on a plain background or in use? Clear product shots are what make visitors want to buy.`,
    (v) =>
      `Do you have photos of your shop or workspace, or of the people behind ${v.business}? Seeing who they are buying from helps new customers trust you.`,
    () =>
      "Do you have a few photos of your best sellers? We can feature them right on the homepage.",
  ],
}

/** For an industry the keyword table could not place. */
const GENERIC: Photos = [
  (v) =>
    `Do you have any photos of ${yourWork(v)}? ${v.offering ? `Shots of ${lower(v.offering)} or of ${v.business} in action` : `Real shots of ${v.business} in action`} help people picture working with you, and they build trust before anyone gets in touch.`,
  (v) =>
    `Do you have photos of yourself, your team or where you work, or any qualifications you'd like to show? People choosing ${v.business} like to know who they'll be dealing with.`,
  (v) =>
    `Do you have a few photos of ${yourWork(v)}? We can feature the best ones on the homepage, so visitors see what ${v.business} does before they read a word.`,
]

/** The photo question alone. */
export function photoQuestion(v: Voice): string {
  const set = v.industry?.category ? PHOTOS[v.industry.category] : GENERIC
  return say(v, pick(v, "photos", set)(v))
}

/** Phase 3 to 4: the look they picked, then the photos that bring it to life. */
export function photos(v: Voice): string {
  const preset = v.template && v.palette
  const lead = pick(v, "to_photos", [
    `Great pick! ${preset ? `That ${v.template} layout with the ${v.palette} colours` : "The look you've chosen"} will make ${v.business} look sharp and inviting.

To make it truly yours, I'd love some real photos.`,
    `That's the look settled. ${preset ? `${v.template} with ${v.palette} colours` : "Your own style"} is going to suit ${v.business} really well.

The one thing a template can't give you is real photos.`,
    `Good choices${comma(v.owner)}. I can already picture ${v.business} in ${preset ? `that ${v.template} layout` : "the look you described"}.

Photos are what will make it feel like yours.`,
  ])
  const close = pick(v, "photos_close", [
    "If you have some, drop them in below. If not, no worries at all, we can skip this for now.",
    "You can add them below, or skip this for now.",
  ])
  return `${say(v, lead)} ${photoQuestion(v)} ${say(v, close)}`
}

/** Phase 4 to 5: the build runs in the background and the chat stays open. */
export function started(v: Voice, uploaded: boolean): string {
  return say(
    v,
    pick(v, "started", [
      `Everything is set! I have all the pieces I need, your services, your style${uploaded ? " and your photos" : ""}.

I'm starting the website build for ${v.business} in the background right now. You'll see live progress in the activity panel, but you don't have to wait around in silence. Feel free to keep chatting with me or ask me anything while I finish up. I'll let you know as soon as the first draft is ready.`,
      `That's everything, thank you${comma(v.owner)}. I'm starting on the website for ${v.business} now.

It builds in the background, and you can follow along in the activity panel. There's no need to sit and watch. Ask me anything in the meantime, and I'll tell you the moment the first draft is ready.`,
      `All set. The build for ${v.business} is under way.

It takes a little while, so keep chatting with me if you like. Progress shows in the activity panel, and I'll let you know here as soon as there's a draft to look at.`,
    ])
  )
}

/** The build was refused, so the owner learns it and how to try again. */
export function notStarted(v: Voice): string {
  return say(
    v,
    "I have everything I need, but I couldn't start the build just now. Whenever you're ready, ask me to build your website and I'll try again."
  )
}

/** The end of the "Skip" path. No manual builder exists yet, and this says so. */
export function manualEnd(v: Voice, builder: boolean): string {
  return say(
    v,
    builder
      ? pick(v, "manual_yes", [
          "Thanks for telling me. To be honest with you, the website builder isn't in the app yet, so there's nothing to open today. When it's ready you'll find it on the Website page. Until then I'm here for anything else, and if you'd like me to build the site after all, just say so.",
          "Good to know. I should be straight with you, the builder isn't ready in the app yet. It will live on the Website page when it is. In the meantime, if you change your mind, I can build the site for you whenever you ask.",
        ])
      : pick(v, "manual_no", [
          "That's completely fine. Your website will be on the Website page whenever you want to come back to it, and if you'd like me to build it for you later, just ask. I'm here whenever you need me.",
          "No problem at all. The Website page is there whenever you're ready, and I can build the site for you any time you ask. Until then, I'm here if you need anything.",
        ])
  )
}

export type RetryReason =
  | "phone"
  | "email"
  | "long"
  | "unclear"
  | "choice"
  | "yes_no"
  | "upload"

const RETRIES: Record<RetryReason, string> = {
  phone:
    "I'll need the number with its country code, like +44 7700 900123, so it works for every visitor. What's the best number?",
  email:
    "That doesn't look quite like an email address. Could you check it and send it again?",
  long: "That's a bit long for this one. Could you say it more briefly?",
  unclear: "Sorry, I didn't quite catch that. Could you put it another way?",
  choice:
    "Sorry, I didn't quite catch which one you meant. Could you pick one of these?",
  yes_no:
    "Sorry, I'm not sure whether that's a yes or a no. Which would you prefer?",
  upload:
    "Whenever you're ready, add your photos in the box below. If you'd rather not, just say skip.",
}

/** A gentle line that asks the same question again, and why. */
export function retry(reason: RetryReason, v: Voice): string {
  return say(v, RETRIES[reason])
}
