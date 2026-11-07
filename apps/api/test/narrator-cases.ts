/**
 * The narrator cases from the fast-model benchmark of 2026-11-06
 * (`.local/research/fast-model-bench/bench.mjs`, NARRATE_CASES): a turn's
 * owner message, its reasoning and tools, and what a good line must name.
 */
export const NARRATE_CASES = [
  {
    id: "reminder",
    message:
      "Remind me on Tuesday morning to call Mrs Patel about her usual clean",
    reasoning:
      "**Planning the reminder** Owner wants a call reminder. Tuesday is 10 November, morning means 9am unless they said otherwise. Load reminders-and-time first.",
    tools: [["skill_view", { name: "reminders-and-time" }]] as const,
    good: "Setting Tuesday's reminder to call Mrs Patel",
    check: (o: string) => /patel|tuesday/i.test(o),
  },
  {
    id: "colours",
    message: "Can you make the homepage colours warmer?",
    reasoning:
      "**Weighing a palette change** Current palette is cool greys and teal. Warmer could mean terracotta and cream. This is a site change, check the site-change skill and the live site first.",
    tools: [
      ["get_workspace", {}],
      ["skill_view", { name: "site-change" }],
    ] as const,
    good: "Looking at warmer colours for your homepage",
    check: (o: string) => /homepage|colour|palette|warm/i.test(o),
  },
  {
    id: "reviews",
    message: "How did my reviews do this week?",
    reasoning: "",
    tools: [
      ["skill_view", { name: "weekly-review" }],
      ["get_review", {}],
    ] as const,
    good: "Reading this week's reviews",
    check: (o: string) => /review/i.test(o) && /week/i.test(o),
  },
]

const words = (s: string) => s.split(/\s+/).filter(Boolean).length

/** The benchmark's shape for a line: 3 to 9 words, a participle first, no I or you, no full stop. */
export const narrateShape = (o: string) =>
  words(o) >= 3 &&
  words(o) <= 9 &&
  o.length <= 62 &&
  /^[A-Z][a-z]+ing\b/.test(o) &&
  !/\b(I|I'm|you)\b/.test(o) &&
  !/\.$/.test(o)
