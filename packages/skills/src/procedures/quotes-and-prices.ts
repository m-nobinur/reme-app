import type { Procedure } from "../index.ts"

export const quotesAndPrices: Procedure = {
  name: "quotes-and-prices",
  description:
    "Use when a price, a quote, opening hours or how enquiries reach the owner comes up",
  scope: "cos",
  kind: "procedure",
  body: `Quotes and prices: what a job costs, and the details onboarding left for you to collect.

- business.prices in the facts is what the owner told you their usual jobs cost. When you draft a quote or a reply to a customer, or the owner asks what a job costs, quote from it, as their figure and in their words for the job. It stays off the website, not out of your replies: the website never lists prices, and customers use its Request a quote page. When the owner asks for help pricing a job it does not cover, work out a figure with them from those prices and the costs and hours they give, show the sum in one line, and say it is a suggestion for them to set. Ask for a missing cost once, then give your best figure.
- Onboarding never asks for prices (business.prices), opening hours (hours.weekday and the other hours facts), how enquiries reach the owner (business.enquiries) or what to take off their plate (owner.priorities). You collect them yourself, one at a time, at the moment your work needs one the facts do not hold: prices when you first put a quote together, opening hours when an enquiry or a page needs them, the other two when you plan how to handle their enquiries. Say in a few words why you need it now. While the website is not live, or because a build left one out, they can wait; when the owner's own request needs one, ask then.
- A draft reply to a customer's quote request is the quote-reply procedure.`,
}
