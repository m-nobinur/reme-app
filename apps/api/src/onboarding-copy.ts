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
 * by first name when the sign-in gave one, who I am and what I take on
 * (enquiries, quotes, follow-ups; a website only if they want one), a few
 * quick questions to understand the business and its goals, and the first
 * question: what the business does and its main services. Text only, so it
 * ends on the question.
 */
export function opener(v: Voice): string {
  const name = firstName(v.owner)
  const hi = (greeting: string) => (name ? `${greeting} ${name}` : greeting)
  const b = v.business
  return say(
    v,
    pick(v, "opener", [
      `${hi("Hi")}. I'm the new business assistant at ${b}. I'll help with the day-to-day: answering enquiries, preparing quotes and following up with customers.

First I'd like to understand the business and your goals, so I'll ask a few quick questions.

To start, what does ${b} do, and what are your main services?`,
      `${hi("Hello")}. I'll be the business assistant for ${b}, looking after enquiries, quotes and follow-ups so you can get on with the work.

A few quick questions first, so I get a feel for what you do and where you want the business to go.

In your own words, what does ${b} do, and which services do customers come to you for most?`,
      `${hi("Hi")}. I'm your business assistant. Before I take anything on, I'd like to understand ${b} properly.

I'll ask a few quick questions about the business and your goals. Your answers shape how I talk to customers and put quotes together, and your website too if you'd like one.

What does ${b} do, and which services matter most to you?`,
      `${hi("Hi")}. I'm the business assistant for ${b}, here to help run things: replying to enquiries, following up on quotes and keeping track of what needs doing.

A few quick questions will help me understand your business and where you want to take it.

Let's begin with the heart of it: what does the business do, and what are your main services?`,
      `Good to meet you${name ? `, ${name}` : ""}. I'm the business assistant for ${b}.

This won't take long. I'll ask a few quick questions so I understand the business and your goals. Then I can start on enquiries and quotes, and a website if you need one.

First, the big one. What does ${b} do, and what are the main services you offer?`,
      `${hi("Hello")}. I'm your new business assistant, and my first job is getting to know ${b}.

I'll ask a few quick questions about the business and your goals. After that I can take on enquiries, quotes and follow-ups, and set up a website if you need one.

So tell me, what does ${b} do, and what services do you offer?`,
    ])
  )
}

type Asked = Exclude<StepId, "upload" | "build" | "manual_builder">

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
    `What are the main services ${v.business} offers? The ones customers ask for most are a good place to start.`,
    `Which services do people come to ${v.business} for? A short list is plenty.`,
  ],
  "business.audience": (v) => [
    v.offering
      ? `Got it. Who are your ideal customers, the people you'd most like to see booking ${lower(v.offering)}? You can skip this one.`
      : "Got it. Who are your ideal customers, the people you'd most like to hear from? You can skip this one.",
    "Who do you most enjoy working for? The site will speak to them first. It's fine to skip this.",
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
    `Where are you based, and which nearby areas do you cover? Something like "Leeds and anywhere within about 20 miles" is perfect.`,
    `And where does ${v.business} work? The town or city you're in, plus the places around it you're happy to travel to, is all I need.`,
    v.offering
      ? `Which areas do you cover for ${lower(v.offering)}? Your home town and the surrounding areas you'll travel to is plenty.`
      : "Which areas do you cover? Your home town and the surrounding areas you'll travel to is plenty.",
    `So people searching nearby can find you, which city or town are you based in, and which neighbouring areas do you serve?`,
    `Which part of the map is yours? Tell me where you're based and how far you'll go for a job, for example "Manchester, Salford and Stockport".`,
  ],
  // The business's practical side, on one card.
  contact: (v) => [
    `Now the practical bits. Which phone number and email should customers use to reach ${v.business}? Check the details below and change anything that isn't right.`,
    `I have a good picture of ${v.business} now. How should customers get in touch? Add the phone number and the email for enquiries below.`,
    `Just the contact details left for the business: the phone number and the email address enquiries should go to.`,
  ],
  // Phase 1 to 2: what they told us, then the working relationship.
  assistant: (v) => [
    `I have a clear picture of ${v.business} now: who you are and what you offer.

Before we get to the design, how would you like me to introduce myself to you and your visitors? Give me a name and the personality you'd like me to have.`,
    `That's everything I need about ${v.business} for now. I can already picture how the site should read.

Now a little about me. I'll be looking after your enquiries and keeping you posted, so I should have a name and a manner you like. What should we call me, and how should I come across?`,
    `Thanks${comma(v.owner)}. I have a good feel for ${v.business}, and a few ideas for the site already.

Before the website, let's settle who I am on your team. Choose the name I'll go by, my pronouns and the tone I should use with you and your customers.`,
  ],
  pronouns: (v) =>
    v.assistant
      ? [
          `${v.assistant} it is. Which pronouns should I go by?`,
          `${v.assistant}, noted. Which pronouns suit me best?`,
        ]
      : ["Which pronouns should I go by?"],
  tone: () => [
    "And what kind of personality would you like me to have when I talk to you and your customers?",
    "How should I come across when I talk to your customers?",
  ],
  // Phase 2 to 3: the new identity, then the website and the quote page.
  build_for_me: (v) => {
    const ask = `Would you like me to build a website for ${v.business}?`
    return [
      `${v.assistant ? `${v.assistant} it is!` : `Thanks${comma(v.owner)}.`}

I can also build ${v.business} a website, with a Request a quote page that sends each enquiry straight to me with the details you need to reply. If you already have a site, choose Skip for now.

${ask}`,
      `${v.assistant ? `I'm ${v.assistant} from now on${comma(v.owner)}.` : `Thanks${comma(v.owner)}.`}

One more thing I can do: build a website for ${v.business}. Every page would point visitors to Request a quote, and each enquiry would reach me with what you need to quote the job. If you already have a site, just skip this.

${ask}`,
      `Thanks${comma(v.owner)}.

If ${v.business} needs a website, I can build it. It would have a Request a quote page, so customers describe the job and the enquiry comes to me ready for a quote. Already have one? Skip this for now.

${ask}`,
    ]
  },
  // Phase 4: the last questions; their answer starts the build.
  design: (v) => [
    `Last, the look of ${v.business}: the colours, lettering, your logo, the layout, photos and pages, all in the questions below. Leave any to me except the logo, which you can upload or have me create. Then I'll start building.`,
    `Now the look of ${v.business}, the last step before I build. The questions below cover colours, lettering, your logo, layout, photos and pages. Upload a logo or let me create one, and leave the rest to me if you'd rather.`,
  ],
  template: (v) => [
    `Let's design it together. First, the layout. Which of these feels most like ${v.business}?`,
    `We'll start with the overall layout. Which one suits ${v.business} best?`,
  ],
  palette: (v) => [
    v.template
      ? `${v.template} it is. Which colours feel right for ${v.business}?`
      : `Thanks, I'll keep your notes in mind. Which colours feel right for ${v.business}?`,
    `Noted. Now for colour. Which of these palettes fits ${v.business}?`,
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
  // Phase 3: right after the yes to the website, what a quote needs, in their words.
  quote_form: (v) => [
    `I'll build it. First, the Request a quote form, so every enquiry arrives with what you need. Think of things like the date, the address or the size of the job.

When someone asks ${v.business} for a quote, what do you usually find out first?`,
    `Then let's start with your Request a quote form. List whatever comes to mind and I'll turn it into a tidy form.

Picture a new customer getting in touch: what do you need to know from them before you can quote properly?`,
    `Good${comma(v.owner)}. One practical thing first: I'll shape the quote form on your site around your answer, so enquiries about ${services(v)} come with the details you need.

Think about the last few quotes you gave. What did you need to ask the customer before you could work them out?`,
    v.offering
      ? `First, the quote form. For ${lower(v.offering)}, the usual things are when, where and what the job involves, but you know your customers best.

So customers can ask for a quote in one go, what should the form ask them?`
      : `First, the quote form. The usual things are when, where and what the job involves, but you know your customers best.

So customers can ask for a quote in one go, what should the form ask them?`,
  ],
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

/** After the design: the build runs in the background and the chat stays open. */
export function started(v: Voice, uploaded: boolean): string {
  return say(
    v,
    pick(v, "started", [
      `That's everything I need: ${services(v)}, your style${uploaded ? " and your photos" : ""}.

I've started building the website for ${v.business} in the background. You'll see progress in the activity panel, and there's no need to wait: keep chatting or ask me anything while it runs. I'll let you know as soon as the first draft is ready.`,
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

/**
 * The end of the "Skip" path: no builder question, since connecting a site
 * the owner already has is coming and nothing else is offered in its place.
 */
export function manualEnd(v: Voice): string {
  return say(
    v,
    pick(v, "manual_end", [
      `No problem${comma(v.owner)}. If you already have a website, connecting it to me is coming soon, so stay tuned. Until then I'm here for enquiries, quotes and follow-ups, and if you'd like me to build ${v.business} a site after all, just ask.`,
      `That's fine${comma(v.owner)}. Connecting a website you already have is on its way, so stay tuned. In the meantime I can help with enquiries, quotes and anything else ${v.business} needs, and I can build a site whenever you want one.`,
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
