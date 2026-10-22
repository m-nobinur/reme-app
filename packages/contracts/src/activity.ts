import { z } from "zod"
import { Timestamp } from "./common.ts"
import { Text } from "./text.ts"

// The owner's activity view as state, never sentences: the web writes every
// word from kind, state and step, with the assistant's name and the business
// zone, so the copy lives in one tested place.

/**
 * One step of a segment. A segment's list is fixed from its first moment, so
 * a step is never added or removed, only moved along; `skipped` is a step
 * that does not apply to this run and stays in the list.
 */
export const ActivityStep = z.strictObject({
  /** Fixed per segment kind, such as "contact", "photos" or "pages". */
  id: z.string().regex(/^[a-z][a-z0-9_]{1,29}$/),
  state: z.enum(["done", "now", "waiting", "next", "skipped"]),
  /** What was settled, as the owner would say it: "Regular cleans, end of tenancy". The owner's words, shown as data. */
  value: Text(120).optional(),
  count: z
    .strictObject({
      done: z.int().nonnegative().max(999),
      total: z.int().positive().max(999),
    })
    .optional(),
})

/** The most steps a segment lists. */
export const ACTIVITY_STEPS_MAX = 12

/** One piece of work with a title and fixed steps: a build, a domain, a reminder, a turn. */
export const ActivitySegment = z.strictObject({
  id: Text(80),
  kind: z.enum([
    "onboarding",
    "website",
    "golive",
    "change",
    "domain",
    "purchase",
    "google",
    "reminder",
    "review",
    "question",
    "checkin",
    "turn",
  ]),
  state: z.enum(["upcoming", "now", "waiting", "done", "failed"]),
  steps: z.array(ActivityStep).max(ACTIVITY_STEPS_MAX),
  /** When it started, is due or finished. */
  at: Timestamp,
  /** When a waiting chance closes. */
  deadline: Timestamp.optional(),
  /** Copy inputs, never ids. */
  names: z
    .strictObject({
      business: Text(120).optional(),
      host: Text(253).optional(),
      domain: Text(253).optional(),
    })
    .optional(),
  /** A model-written line for "change" and "turn", cleaned: shown as data. */
  step: Text(60).optional(),
})

/** The most segments one group lists. */
export const ACTIVITY_SEGMENTS_MAX = 20

const Segments = z.array(ActivitySegment).max(ACTIVITY_SEGMENTS_MAX)

/** Every segment, grouped. `journey` is onboarding, website and go live, until the site is first live. */
export const Activity = z.strictObject({
  journey: Segments,
  now: Segments,
  waiting: Segments,
  upcoming: Segments,
  done: Segments,
})

export type ActivityStep = z.infer<typeof ActivityStep>
export type ActivitySegment = z.infer<typeof ActivitySegment>
export type Activity = z.infer<typeof Activity>
