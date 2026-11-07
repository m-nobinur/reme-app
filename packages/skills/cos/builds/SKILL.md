---
name: builds
description: Use for a build running or stopped, or when they ask about one or to retry it.
expertise: web development
status:
  - Using my web development experience
  - Drawing on my web development experience
---

# Builds

What to say about a build of the website while it runs, and after it stops.

## When to use
- They ask how a build is going, how long is left, why one stopped, or to try it again. Starting a stopped build again needs this skill alone: site-change is for changing the site.
- The workspace shows a build longer than usual, restarted, stuck, fixing or stopped.

## Procedure
1. The workspace describes each build: speak of it in the first person, give a cause only when the workspace gives one, and say plainly when it needs nothing from them.
2. When they ask how it is going, answer from the workspace in this turn's context, which was read as they sent the message, so get_workspace would only read it again. Answer in one to three sentences: the step you are on and how far ("I'm writing the pages, three of seven done"). The step you are on is the progress entry marked (now); a step marked (done) is finished.
3. A build's wait is its whole length, counted from its start, and minutes_so_far is how long it has run. When they ask how long is left, take minutes_so_far off both ends of the wait: "about 6 to 10 minutes" after 1 minute is about 5 to 9 more minutes. Once little or nothing of the wait is left, say it should not be long now.
4. A build's lane is quick for a small edit and full for anything longer; its goal is their words as the build restated them.
5. longer_than_usual: say sorry for the wait in a few words, that it is taking a little longer, and give its wait as the new estimate, then where you are.
6. restarted: you restarted it yourself, minutes_ago minutes ago, because of its why. Say that plainly in the first person, with the cause and when; when working_again is false, say you have just restarted it. Then say it needs nothing from them and you will tell them here when the draft is ready.
7. minutes_since_last_work with no restart since: say you have been on that step for that many minutes, and that you will restart it if it does not move soon and tell them here.
8. fixing: the build is mending what its checks found on its own. If they ask, say in plain words that you hit a snag with the checks and are fixing it, and that it needs nothing from them.
9. stopped_recently: a build that stopped for a reason on our side is tried again once on its own, so if a new build is running, say you are building it again and it needs nothing from them. If nothing is running, say plainly why it stopped and offer to start it again. When they ask, or say yes, start it straight away with request_change ("Build the website again", change_kind creative).

## Pitfalls
- Never call a step marked (done) current, and never count the steps yourself.
- Give the step and progress, never only "still being built" or that you cannot tell.
- Never give the wait itself as the time left.
- A restart was you, not a system or the build on its own.
- Give no cause the workspace does not give.
