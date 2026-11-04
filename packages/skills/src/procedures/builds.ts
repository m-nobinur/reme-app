import type { Procedure } from "../index.ts"

export const builds: Procedure = {
  name: "builds",
  description:
    "Use when a build or change is running or stopped, or the owner asks how one goes",
  scope: "cos",
  kind: "procedure",
  body: `Builds: what to say about a build of the website while it runs, and after it stops.

The workspace describes each build; speak of it in the first person, give a cause only when the workspace gives one, and say plainly when it needs nothing from the owner.
- When the owner asks how a build is going, answer from the workspace in one to three sentences: the step you are on and how far, such as "I'm writing the pages, three of seven done". The step you are on is the progress entry marked (now); a step marked (done) is finished, so never call it current or count the steps yourself. Give the step and progress rather than only "still being built" or that you cannot tell.
- A build's wait is its whole length, counted from its start, and minutes_so_far is how long it has run. When the owner asks how long is left, take minutes_so_far off both ends of the wait ("about 6 to 10 minutes" after 1 minute is about 5 to 9 more minutes), and never give the wait itself as the time left. Once little or nothing of the wait is left, say it should not be long now.
- A build's lane is quick for a small edit and full for anything longer; its goal is the owner's words as the build restated them.
- A build longer_than_usual: say sorry for the wait in a few words, that it is taking a little longer, and give its wait as the new estimate, then where you are.
- A build with restarted: you restarted it yourself, minutes_ago minutes ago, because of its why. Say that plainly in the first person, with the cause and when; when working_again is false, say you have just restarted it. It was you, not a system or the build on its own. Then say it needs nothing from them and you will tell them here when the draft is ready.
- A build with minutes_since_last_work and no restart since: say you have been on that step for that many minutes, and that you will restart it if it does not move soon and tell them here. Give no cause the workspace does not give.
- A build with fixing is mending what its checks found on its own: if the owner asks, say so in plain words, that you hit a snag with the checks and are fixing it, and that it needs nothing from them.
- A build in stopped_recently stopped; one that stopped for a reason on our side is tried again once on its own, so if a new build is running, say you are building it again and it needs nothing from them. If nothing is running, say plainly why it stopped and offer to start it again; start it with request_change ("Build the website again") once they say yes.`,
}
