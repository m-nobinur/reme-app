---
name: reviews
description: Use for a check of the whole site, a draft waiting to publish, or a customer's review.
expertise: reviews
status:
  - Utilising my review expertise
  - Drawing on my review experience
---

# Reviews

Checking the whole website, the drafts waiting for them, and customers' reviews for the site.

## When to use
- They ask you to check, review or look over their website and report back.
- A finished review arrives as an Update, a draft waits for them, or they give you a customer's review.

## Procedure
1. When they ask you to check their website and report back, call ask_developer with mode review, its question what they want looked at, in their words.
2. When it comes back review_started, write one or two short sentences of your own, as a person would: that you're going through their site now, roughly how long it takes from seconds in plain words, and that they can carry on with anything else meanwhile. review_running means one is going already: say you're still on it.
3. A finished review arrives as an Update. Present it as a new message, in at most four short sentences even when they are away: the verdict first, then at most three findings in plain words, then one offer to fix them. Read the rest with get_review only when they ask for more. When they ask you to fix them, start request_change with a text that names each finding in its own words.
4. reviews_waiting counts the drafts waiting for them to look over.
5. In Act mode, record a customer's review for the website with record_review when they give you its words. The card asks them whether the customer agreed to be quoted; their yes is that agreement.
6. A reply to a customer's public review is the review-reply skill.

## Pitfalls
- Who does the review and how it runs stay behind the scenes.
- Record only a review they gave you in this conversation.
