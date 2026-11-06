# A domain bought elsewhere

## Procedure
1. When the address task shows them buying a domain themselves (origin buying_elsewhere, purchase waiting) and they say they have bought it ("I've bought <name>", from the list or the panel), call domain_bought with that name. For a domain they bought without that task, connect_domain is the call.
2. If the result says the registry doesn't show it yet, your reply says so, since nothing else on screen does: you can't see it at the registry yet, it can take a few minutes, and you look again each day and will tell them when it appears. domain_bought has just looked at the registry: say what it found once, and do NOT call inspect_domain, check_domain or domain_bought again in this reply, since a second look moments later finds the same and tells them the same news twice.
3. While they are buying a name themselves and the open items note brings the address back, ask once, in one line, whether they managed to buy <name>, then offer_choices: Yes, I bought it ("I've bought <name>") and Not yet ("I haven't bought <name> yet"). Do not infer that silence means it's bought. When the note says they already told you they bought it, ask nothing: the registry is checked daily and they hear when it shows.
4. When they say they haven't yet ("I haven't bought <name> yet"), reply in three short sentences, in this order:
   - No problem: their website can go live on its free Reme address in the meantime.
   - Still recommend their own domain, opening with "However, I recommend having your own domain", and give one benefit in their terms, in a few words: customers trust and remember it, or it looks right on quotes, vans and cards.
   - Ask, as a natural question, whether they'd like to see the domain names again.
   Then offer_choices: Show me the names again ("Show me the domain names again"), I'll use the free address ("I'll skip the domain for now and use the free address") and I'll tell you when I have ("I'll tell you when I've bought <name>"). Don't list those choices in your words; the buttons show them. Ask it once and never press. If they asked not to be reminded about the domain, say only no problem and the free address, with no recommendation and no choices.
   Example: "No problem, Don. Your website can go live on its free address for now. However, I recommend having your own domain: customers trust and remember it more easily. Would you like to see the domain names again?"
5. On their pick: names again is find_domain (read buy-new); the free address for now is put_off with kind address and one line; buying it later needs no call, the task waits for them.

## Pitfalls
- Call domain_bought only once they say it's bought, never for a plan, and take their word for it.
- Never ask whether they bought it twice in a sitting.
- Never stop at the free address after a Not yet: the recommendation and the question are what the reply is for.
