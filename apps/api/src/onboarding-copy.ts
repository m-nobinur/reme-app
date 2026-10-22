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
  /** The label of the design direction the owner picked on the tray, or null for their own words or the builder's choice. */
  direction: string | null
  /** The owner's own words for the layout or the lettering when they chose no preset. */
  ownLook: string | null
  /** The owner's own colour when they chose no preset: a colour code or their words. */
  ownColour: string | null
  /** The services as a short phrase written in the background, such as "your wedding cars". */
  services: string | null
  /** The photo question written in the background for this business. */
  photoQuestion: string | null
}

/** FNV-1a over UTF-16 units: stable across isolates and deploys. */
export function hash(text: string): number {
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

/** The first word of the owner's name, or "" when the sign-in gave none. */
export const firstName = (owner: string) => owner.trim().split(/\s+/)[0] ?? ""

/**
 * The first message, six ways, written at sign-up with no model: a greeting
 * by first name when the sign-in gave one, thanks for choosing me as their
 * business assistant, a few quick questions to understand the business and
 * its goals, a website tailored to it, and the first question: what the
 * business does and its main services. Text only, so it ends on the question.
 */
export function opener(v: Voice): string {
  const name = firstName(v.owner)
  const hi = (greeting: string) => (name ? `${greeting} ${name}` : greeting)
  const b = v.business
  return say(
    v,
    pick(v, "opener", [
      `${hi("Hi")}, and thank you for choosing me as your business assistant! I'm really glad to be working with ${b}.

I'll ask a few quick questions so I can understand your business and your goals, and then I'll build you a website tailored to ${b}.

To start, tell me about the business. What does ${b} do, and what are your main services?`,
      `${hi("Hello")}! It's lovely to meet you. Thank you for picking me to be the business assistant for ${b}.

Here's the plan. A few quick questions first, so I get a feel for what you do and what you want from the business, then I'll put together a website made just for you.

In your own words, what does ${b} do, and which services do customers come to you for most?`,
      `Welcome${name ? `, ${name}` : ""}. Thank you for trusting me as your business assistant.

Before anything gets built, I'd like to understand ${b} properly, so I'll ask a few quick questions about the business and your goals. With that, I can shape a website around you rather than a template.

What does ${b} do, and which services matter most to you?`,
      `${hi("Hi")}! Thanks for choosing me to help run things at ${b}. I'm your new business assistant, and I'm excited to get started.

A few quick questions will help me understand your business and where you want to take it. Then I'll build a website that fits ${b}.

Let's begin with the heart of it: what does the business do, and what are your main services?`,
      `Good to meet you${name ? `, ${name}` : ""}. Thank you for choosing me as the business assistant for ${b}.

This won't take long. I'll ask a few quick questions so I can understand the business and your goals, and I'll use your answers to build a website tailored to you.

First, the big one. What does ${b} do, and what are the main services you offer?`,
      `${hi("Hello")}, and welcome! I'm glad you chose me as your business assistant.

My first job is getting to know ${b}, so I'll ask a few quick questions, just enough to understand the business and your goals. Then I'll build you a website made to fit.

So tell me, what does ${b} do, and what services do you offer?`,
    ])
  )
}

type Asked = Exclude<StepId, "upload" | "build">

/** "your services", or the phrase written for this business. */
const services = (v: Voice) => v.services ?? "your services"

const QUESTIONS: Record<Asked, (v: Voice) => string[]> = {
  "business.name": () => [
    "One quick check. What's your business called, as you'd like customers to see it?",
    "Before we go on, what name should customers know your business by?",
  ],
  industry: (v) => [
    `To start, what kind of business is ${v.business}?`,
    `First things first. Which of these comes closest to what ${v.business} does?`,
  ],
  "business.offerings": (v) => [
    `Lovely. What are the main services ${v.business} offers? The ones customers ask for most are a good place to start.`,
    `Thanks. Which services do people come to ${v.business} for? A short list is plenty.`,
  ],
  "business.audience": (v) => [
    v.offering
      ? `Got it. Who are your ideal customers, the people you'd most like to see booking ${lower(v.offering)}? You can skip this one.`
      : "Got it. Who are your ideal customers, the people you'd most like to hear from? You can skip this one.",
    "Thanks, that's useful. Who do you most enjoy working for? The site will speak to them first. It's fine to skip this.",
  ],
  // Who runs the business and real proof points: the About page's person
  // and the site's credibility. Never required.
  "business.proof": (v) => [
    `Who's behind ${v.business}, and what sets it apart? Your name, how long you've been trading, accreditations, insurance or a guarantee all help, and a review you can quote counts too. It's fine to skip this one.`,
    "Tell me a little about who runs the business and why customers choose you. Your name, years in business, qualifications, awards or a guarantee all help the site earn trust. You can skip this if nothing comes to mind.",
    "One more about the business. Who's behind it, and is there anything you're proud of that the site could mention, such as years trading, memberships or a guarantee? Skipping is fine.",
  ],
  // Where the business works, asked the way a local customer would think of it.
  "service_area.text": (v) => [
    `Lovely. Where are you based, and which nearby areas do you cover? Something like "Leeds and anywhere within about 20 miles" is perfect.`,
    `And where does ${v.business} work? The town or city you're in, plus the places around it you're happy to travel to, is all I need.`,
    v.offering
      ? `Great. Which areas do you cover for ${lower(v.offering)}? Your home town and the surrounding areas you'll travel to is plenty.`
      : "Great. Which areas do you cover? Your home town and the surrounding areas you'll travel to is plenty.",
    `So people searching nearby can find you, which city or town are you based in, and which neighbouring areas do you serve?`,
    `Which part of the map is yours? Tell me where you're based and how far you'll go for a job, for example "Manchester, Salford and Stockport".`,
  ],
  // The business's practical side, on one card.
  contact: (v) => [
    `Thanks, that's really helpful. Now the practical bits. Which phone number and email should customers use to reach ${v.business}? Check the details below and change anything that isn't right.`,
    `Lovely, I'm getting a good feel for ${v.business}. How should customers get in touch? Add the phone number and the email for enquiries below.`,
    `That's great, thank you. Just the contact details left for the business: the phone number and the email address enquiries should go to.`,
  ],
  // Phase 1 to 2: what they told us, then the working relationship.
  assistant: (v) => [
    `Thank you! I have a really clear picture of what ${v.business} is all about now. Since I know who you are and what you offer, let's make our partnership official.

Before we get to the design, how would you like me to introduce myself to you and your visitors? Give me a name and the personality you'd like me to have.`,
    `That's everything I need about ${v.business} for now, thank you. I can already picture how the site should read.

Now a little about me. I'll be looking after your enquiries and keeping you posted, so I should have a name and a manner you like. What should we call me, and how should I come across?`,
    `Thanks${comma(v.owner)}. I have a good feel for ${v.business}, and a few ideas for the site already.

Before the website, let's settle who I am on your team. Choose the name I'll go by, my pronouns and the tone I should use with you and your customers.`,
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
  // Phase 2 to 3: the new identity, then the website and the quote page.
  build_for_me: (v) => {
    const ask = "Would you like me to build your website for you?"
    return [
      `Good to be officially on the team${comma(v.owner)}.

Now let's turn to your website. Every growing business needs one that turns visitors into real enquiries, so yours will have its own Request a quote page for your services.

${ask}`,
      `Lovely to meet you properly${comma(v.owner)}.${v.assistant ? ` I'm ${v.assistant}, and` : " I'm"} glad to be on board.

Let's talk about your website. It's often the first thing a new customer sees of ${v.business}, so getting in touch has to be easy. Every page will point visitors to Request a quote, and each enquiry will arrive with the details you need to reply.

${ask}`,
      `Thanks${comma(v.owner)}.${v.assistant ? ` ${v.assistant}, reporting for duty!` : ""}

Next is the part most owners put off, the website. A good one turns visitors into real enquiries, and yours will have a Request a quote flow so customers can describe the job and you can reply with the right quote.

${ask}`,
    ]
  },
  manual_builder: (v) => [
    `No problem${comma(v.owner)}. Would you like to build the website yourself with the website builder instead?`,
    `That's fine${comma(v.owner)}. Would you rather put the website together yourself in the builder?`,
  ],
  design: (v) => [
    `Wonderful, let's design it together. Four quick questions below set the colours, the lettering, the layout and the pages for ${v.business}. Skip any you like and I'll choose for you.`,
    `Brilliant. Now the look of ${v.business}. Four quick questions below cover colour, lettering, layout and pages, and you can skip them all if you'd rather I chose.`,
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
  font: (v) =>
    [
      "And which style of lettering suits your brand?",
      "Now the lettering. Which of these feels most like you?",
    ].map((ask) => `${colourNoted(v)}${ask}`),
  pages: () => [
    "Nearly there. Which pages should the site have? I've ticked the ones most businesses start with.",
    "Last design question. Which pages do you want? The usual ones are already ticked.",
  ],
  // Phase 3: the look they picked, then what a quote needs, in their words.
  quote_form: (v) => {
    const look = lookOf(v)
    return [
      `Great pick! I think ${look} will make ${services(v)} look sharp and inviting.

Now let's make sure every enquiry arrives with what you need. Think of things like the date, the address or the size of the job. When someone asks ${v.business} for a quote, what do you usually find out first?`,
      `Lovely, ${look} is going to suit ${v.business} really well.

Next, your Request a quote form. List whatever comes to mind and I'll turn it into a tidy form. Picture a new customer getting in touch: what do you need to know from them before you can quote properly?`,
      `Good choices${comma(v.owner)}. I can already picture ${services(v)} in ${look}.

One practical thing before I build: I'll shape the quote form on your site around your answer. Think about the last few quotes you gave. What did you need to ask the customer before you could work them out?`,
      v.offering
        ? `Love it, ${look} will show off ${services(v)} nicely.

For ${lower(v.offering)}, the usual things are when, where and what the job involves, but you know your customers best. So customers can ask for a quote in one go, what should the form ask them?`
        : `Love it, ${look} will show off ${services(v)} nicely.

The usual things are when, where and what the job involves, but you know your customers best. So customers can ask for a quote in one go, what should the form ask them?`,
    ]
  },
}

/**
 * The look the owner has picked, as a noun phrase: the old template and
 * colours, else the tray's direction and palette, else what they wrote, and
 * only with nothing at all the builder's own choice.
 */
function lookOf(v: Voice): string {
  if (v.template && v.palette)
    return `that ${v.template} layout with the ${v.palette} colours`
  if (v.direction && v.palette) return `the ${v.direction} look in ${v.palette}`
  if (v.direction) return `the ${v.direction} look`
  if (v.palette) return `the ${v.palette} colours`
  if (v.ownColour || v.ownLook) return "the look you described"
  return `the look I'll choose for ${v.business}`
}

/** The palette the owner just chose, said back before the next question. */
function colourNoted(v: Voice): string {
  if (v.palette) return `${v.palette} it is. `
  if (!v.ownColour) return ""
  return v.ownColour.startsWith("#")
    ? `I'll build the colours around ${v.ownColour}. `
    : `I'll pick colours to match "${v.ownColour}". `
}

/** The step's question, with the phase transition for a step that opens a phase. */
export function question(step: Asked, v: Voice): string {
  return say(v, pick(v, step, QUESTIONS[step](v)))
}

/**
 * The photo question, three ways per industry. Chauffeur and legal are the
 * owner's own lines; the rest follow their voice: a specific question, then
 * why it matters.
 */
type Photos = ((v: Voice) => string)[]

/** The owner's industry as a noun phrase, for the lines that name it. */
const work = (v: Voice) =>
  v.industry ? `your ${lower(v.industry.name)} work` : "your work"

const PHOTOS: Partial<Record<IndustryId, Photos>> = {
  chauffeur: [
    () =>
      "Do you have any photos of your fleet, like exterior shots of the vehicles, interior luxury features, or your chauffeurs in uniform? Showing off your cars is the best way to help clients picture their ride.",
    () =>
      "Do you have photos of your limos in action, for example, at weddings, corporate events, or airport pickups? Real shots of your vehicles make a huge impression on visitors.",
    () =>
      "Do you have a few photos of your vehicles, both inside and outside? We can feature your best fleet photos right on the homepage to highlight the luxury experience.",
  ],
  legal: [
    () =>
      "Family law is deeply personal, so clients really connect with familiar, approachable faces. Do you have a professional headshot, a photo of your team, or your office space that we could feature?",
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
}

/** For every other industry, the owner's own "Something else" included. */
const GENERIC: Photos = [
  (v) =>
    `Do you have any photos of ${work(v)}${v.offering ? `, like ${lower(v.offering)},` : ""} or of ${v.business} in action? Real photos help people picture working with you, and they build trust before anyone gets in touch.`,
  (v) =>
    `Do you have photos of yourself, your team or your workplace, or any qualifications you'd like to show? People choosing ${v.business} like to know who they'll be dealing with.`,
  (v) =>
    `Do you have a few photos of ${work(v)}? We can feature the best ones on the homepage.`,
]

/** The photo question alone: the one written for this business, or the industry's. */
export function photoQuestion(v: Voice): string {
  if (v.photoQuestion) return say(v, v.photoQuestion)
  const set = (v.industry?.category && PHOTOS[v.industry.category]) || GENERIC
  return say(v, pick(v, "photos", set)(v))
}

/** The quote form settled, then the photos and a logo that make the site theirs. */
export function photos(v: Voice): string {
  const lead = pick(v, "to_photos", [
    "Thanks, the quote form is set. To make the site truly yours, I'd love some real photos.",
    "Perfect, that's the quote form sorted. The one thing a template can't give you is real photos.",
    "Great, your quote form is ready. Now, photos are what will make the site feel like yours.",
  ])
  const close = pick(v, "photos_close", [
    "A logo is welcome too. If you have some, drop them in below. If not, no worries at all, we can skip this.",
    "Your logo is welcome too. Add them below, or skip this for now.",
  ])
  return `${say(v, lead)}\n\n${photoQuestion(v)} ${say(v, close)}`
}

/** The quote form, for when no model can draft one: a short form the owner confirms or changes. */
export function quoteForm(v: Voice): string {
  return say(
    v,
    pick(v, "quote_form", [
      `One last thing before I build. Every enquiry from the site comes through Request a quote, so what should it ask a customer? I've started a short form for ${v.business} below. Keep it, or tell me what you need to know to quote a job and I'll change it.`,
      `Nearly there. When a customer asks ${v.business} for a quote, what do you need to know first? Here's a simple form to start from. Confirm it, or say what to add.`,
      `Almost ready to build. Here's a starting point for your quote form, so customers tell you what you need in one go. Does it cover it, or is there something you always ask first?`,
    ])
  )
}

/** Phase 4 to 5: the build runs in the background and the chat stays open. */
export function started(v: Voice, uploaded: boolean): string {
  return say(
    v,
    pick(v, "started", [
      `Everything is set! I have all the pieces I need: ${services(v)}, your style${uploaded ? " and your photos" : ""}.

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

/** What the assistant picked for an owner who left a card to it, said before the next question. */
export function chose(v: Voice, what: string): string {
  return say(
    v,
    pick(v, "chose", [
      `Happy to choose for you. I've gone with ${what} for now, and you can change it whenever you like.`,
      `Leave it with me. I've picked ${what}, and it's easy to change later.`,
      `No problem, I've chosen ${what}. You can always change it later.`,
    ])
  )
}

/** `quote` asks again with the script's short form, from `quoteForm`. */
export type RetryReason =
  | "phone"
  | "email"
  | "long"
  | "unclear"
  | "choice"
  | "yes_no"
  | "upload"
  | "details"
  | "quote"

const RETRIES: Record<Exclude<RetryReason, "quote">, string> = {
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
  details:
    "Sorry, I didn't quite catch all of that. Could you fill in the details below?",
}

/** A gentle line that asks the same question again, and why. */
export function retry(reason: Exclude<RetryReason, "quote">, v: Voice): string {
  return say(v, RETRIES[reason])
}
