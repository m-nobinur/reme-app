---
name: site-change
description: Use before any change to the website's words, layout, pages or look, not a rebuild.
expertise: web design
status:
  - Using my web design skills
  - Bringing in my copywriting skills
---

# Site change

Briefing, starting and checking any request that touches the website's words, layout, pages or look.

## When to use
- Before request_change for any change to the website's content or design.
- When a change is ready to check, or they ask to undo one.

## Procedure
1. Understand. Name the edit type: add_content, update_content, remove, move, format, style, add_section, add_page or redesign. Call read_site for the outline, then read_site with the page for the targeted page in full. Done when every target is a real page, section or block id from it.
2. Read before asking. Read their site notes (read_site's notes) and the recent changes (get_change). Done when nothing you are about to ask is answered there.
3. Ask only what changes the brief: at most one question, with your recommended option first. Put low-stakes choices in the brief as your own assumptions.
4. Suggest when the request is vague ("make the deep clean page richer"): propose one concrete version, saying what, where and in what form (a checklist of what it covers, a table, a short section), from what the page lacks and what the trade usually covers. Done when the brief holds content, not adjectives.
5. Draft the brief for request_change: edit_type; targets by id; content as finished copy in the site's voice, their own words exactly where they gave text; placement by id; keep, when they said what must stay; and two or three acceptance checks anyone can make by reading the page. When you wrote new copy longer than a line, or the change adds a section or a page, show them a short draft in chat first, end with offer_choices: Go ahead ("Go ahead with that") and Not now ("Not now, leave it as it is"), and start the change on their yes. Otherwise start it at once.
6. Hand off in one line to them, never a list of steps.
7. Verify, then report. When the change is ready, read get_change: its checks are judged on the built pages, not the builder's account. Report what changed from text_changes and blocks, in plain words. A failed check (passed false) was sent back once already: say plainly which part did not come out as asked and offer to try another way.

### Later
- A fact they change in chat (a phone, a new service, a wider area): offer the site change in one line, targeting every block that shows it.
- Removing a service takes its card, page, menu link, table row, the FAQ answers that name it and its sitemap entry; the old address goes to /services/.
- Undo: get_change's blocks hold each touched block before and after. Start an update_content change whose content is the before text, targeting those blocks. If read_site shows a later change has altered them since, say which one and offer to undo that first.
- When they state how they want the site in general ("bullets, not paragraphs"), or correct a result, save their sentence with save_correction for the builder. A one-off detail is not a note.

## Pitfalls
- A rating, an award or insurance still needs its source before it goes on the site.
- An undecided check (passed null) is not a miss: never report it as one.
- Never say done while a check fails.
