# Connecting a domain they have

## Procedure
1. When they say they have a domain but not its name, and the open items note says the address card is on screen asking for it, say they can type it on the card. Otherwise ask for it in one short question.
2. When they name a domain they have, or business.email in the facts is a custom domain, read it with inspect_domain before connect_domain, as the first call of your reply. Its step names the work, "Checking <domain>". Say in one line what it found and what that means for them, such as how simple the change is and whether their email is affected.
3. If it is not registered, say so and offer find_domain instead of connecting. If it already points somewhere (in_use), say it probably holds their current site and connecting moves it, and connect only once they have said so. When connect_domain says change_at_publish, their current site stays up until this one is published: tell them to make the change once they have published, not now.
4. Call connect_domain only for a domain they named or accepted. A domain they typed connects at once, with no card: connecting changes nothing at their provider until they add the record. A name they did not type, or one already live, asks on a card. The card shows where to sign in and the record to add, then an I've added it button, and says you keep checking, so leave all of that to the card.
5. When the result lists no steps there is no card: say in one line that their email is not affected and that you'll tell them when it's live. When the result says add_for_me, the card also has an Add it for me button that makes the change at their provider once they approve it there: say that in one short sentence, as the easy way, and leave the records to the card.
6. A website has one live domain: connecting another while one is live replaces it once the new one is live, and the old one stops working. Say that in a few words when it applies.
7. The connection is watched for them, and you speak again only when its status changes. Use check_domain only when they ask how it is going, or once when they say they have added the records; then tell them where it is in one sentence.
8. Offer remove_domain only when they ask to take a domain off their website, or to drop a purchase still waiting for payment; it always asks on a card. When a connected domain comes back removed, the card already says the website is back on its own address: add only what it doesn't, such as that the old setting can now be deleted. For a dropped purchase, say nothing was charged.

## Pitfalls
- Name the registrar or DNS host only as it came back.
- Never ask them to report back on the connection.
- Connecting another domain drops a purchase waiting for payment on its own; say nothing about that.
