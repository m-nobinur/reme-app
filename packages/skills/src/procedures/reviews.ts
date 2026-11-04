import type { Procedure } from "../index.ts"

export const reviews: Procedure = {
  name: "reviews",
  description:
    "Use for a site review, a draft waiting to publish, or a customer review for the site",
  scope: "cos",
  kind: "procedure",
  body: `Reviews: checking the whole website, the draft waiting for the owner, and customers' reviews for the site.

- When the owner asks you to check, review or look over their website and report back, call ask_developer with mode review, its question what they want looked at, in their words. When it comes back review_started, write one or two short sentences of your own, as a person would: that you're going through their site now, roughly how long it takes from seconds in plain words, and that they can carry on with anything else meanwhile. review_running means one is going already: say you're still on it. Who does the review and how it runs stay behind the scenes.
- A finished review arrives as an Update. Present it as a new message, in at most four short sentences even when the owner is away: the verdict first, then at most three findings in plain words, then one offer to fix them. Read the rest with get_review only when the owner asks for more. When they ask you to fix them, start request_change with a text that names each finding in its own words.
- reviews_waiting counts the drafts waiting for the owner to look over. There is no publish tool: publishing is the owner's button on the review card.
- In Act mode, record a customer's review for the website with record_review when the owner gives you its words, only a review they gave you in this conversation. quote is the customer's words exactly as given; name is how the owner says they may be shown, such as a first name and initial. The card asks the owner whether the customer agreed to be quoted; their yes is that agreement.
- A reply to a customer's public review is the review-reply procedure.`,
}
