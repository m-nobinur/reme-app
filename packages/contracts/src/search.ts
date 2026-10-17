import { z } from "zod"
import { Timestamp } from "./common.ts"
import { Refused } from "./refused.ts"
import { Text } from "./text.ts"

// Search Console (the owner connects their own Google account). Nothing here
// carries a refresh token, an access token, an org id or a Google account id:
// the model and the web app see the connection's state and email only.

/** Where the owner's Google connection is. `needs_reauth` is a token Google refused. */
export const SearchConnectionState = z.enum([
  "active",
  "needs_reauth",
  "revoked",
])

/** The free subdomain, a connected domain's own address, or a whole purchased domain. */
export const SearchPropertyKind = z.enum(["subdomain", "domain", "url_prefix"])

/** How the owner's ownership is proved: a file the router serves, or a TXT record. */
export const SearchVerifyMethod = z.enum(["file", "dns_txt"])

/** Where a property is. `stale` is one Google no longer lists as verified. */
export const SearchPropertyState = z.enum([
  "pending",
  "verified",
  "failed",
  "stale",
])

/** `POST /google/connect`'s body: what Google's consent screen handed the callback. */
export const GoogleConnectRequest = z.strictObject({
  code: z.string().min(1).max(2048),
  verifier: z
    .string()
    .min(43)
    .max(128)
    .regex(/^[A-Za-z0-9\-._~]+$/),
  redirect_uri: z.string().min(1).max(512),
})

/** The connection as the web app and the model read it: no token, no Google id. */
export const SearchConnection = z.strictObject({
  state: SearchConnectionState,
  google_email: z.email().max(320).nullable(),
  connected_at: Timestamp.nullable(),
})

/** One site Google reads for the org, without its verification token. */
export const SearchProperty = z.strictObject({
  host: Text(253),
  site_url: Text(300),
  kind: SearchPropertyKind,
  method: SearchVerifyMethod,
  state: SearchPropertyState,
  verified_at: Timestamp.nullable(),
})

const Clicks = z.int().nonnegative()
const Rate = z.number().min(0).max(1)

/** A period's totals; `position` is the average, 1 the top of the results. */
export const SearchTotals = z.strictObject({
  clicks: Clicks,
  impressions: Clicks,
  ctr: Rate,
  position: z.number().nonnegative(),
})

/** This period less the one before it: negative is down. */
export const SearchDelta = z.strictObject({
  clicks: z.int(),
  impressions: z.int(),
  ctr: z.number().min(-1).max(1),
  position: z.number(),
})

/**
 * One row of the top 20, by query or by page. `key` is text strangers typed or
 * a page address: untrusted data, tainted on entry to the model's context.
 */
export const SearchRow = z.strictObject({
  key: z.string().min(1).max(500),
  clicks: Clicks,
  impressions: Clicks,
  ctr: Rate,
  position: z.number().nonnegative(),
})

/** Google's verdict on one page, with the strings it gave cut to a length. */
export const UrlStatus = z.strictObject({
  url: z.string().min(1).max(2048),
  verdict: z.enum(["PASS", "NEUTRAL", "PARTIAL", "FAIL", "UNSPECIFIED"]),
  coverage_state: z.string().max(200).nullable(),
  indexing_state: z.string().max(100).nullable(),
  robots_state: z.string().max(100).nullable(),
  google_canonical: z.string().max(2048).nullable(),
  last_crawl_time: Timestamp.nullable(),
  inspected_at: Timestamp,
})

/** The sitemap as Google last reported it, kept on the property row. */
export const SearchSitemap = z.strictObject({
  submitted_at: Timestamp.nullable(),
  last_downloaded: Timestamp.nullable(),
  errors: z.int().nonnegative(),
  warnings: z.int().nonnegative(),
})

/** `connect_google`'s input: nothing, since the owner's tap on Google's screen is the consent. */
export const ConnectGoogleInput = z.strictObject({})

/**
 * `connect_google`'s output: Google's consent link for the owner to open, the
 * account already connected, or that the feature is off. The link is a plain
 * string, not a `uri`, so a tool output shows the model no format. Refused
 * with `forbidden` for a member who is not the owner.
 */
export const ConnectGoogleOutput = z.union([
  z.strictObject({
    url: z
      .string()
      .max(2048)
      .regex(/^https:\/\/\S+$/),
  }),
  z.strictObject({ connected: z.literal(true), email: z.email().max(320) }),
  z.strictObject({ available: z.literal(false) }),
  Refused,
])

/** `get_search_performance`'s input: the window and what to break it down by. */
export const GetSearchPerformanceInput = z.strictObject({
  days: z.literal([7, 28, 90]),
  by: z.enum(["none", "query", "page"]),
})

/**
 * `get_search_performance`'s output: the window's totals, the change from the
 * window before (null when Google has no earlier data), the top 20 rows by
 * the chosen break-down (none for `by: "none"`), the day the data runs to and
 * whether it is older than a day's pull should leave it.
 */
export const GetSearchPerformanceOutput = z.union([
  z.strictObject({
    totals: SearchTotals,
    delta: SearchDelta.nullable(),
    rows: z.array(SearchRow).max(20),
    as_of: z.iso.date(),
    stale: z.boolean(),
  }),
  z.strictObject({ connected: z.literal(false) }),
  Refused,
])

/** `get_indexing`'s input: a page to inspect live, or nothing for the stored verdicts. */
export const GetIndexingInput = z.strictObject({
  url: z
    .string()
    .max(2048)
    .regex(/^https:\/\/\S+$/)
    .optional(),
})

/**
 * `get_indexing`'s output: the property's state, its sitemap as Google last
 * reported it (null before one is submitted) and the per-page verdicts. With
 * a `url`, the one page just inspected.
 */
export const GetIndexingOutput = z.union([
  z.strictObject({
    property: SearchPropertyState,
    sitemap: SearchSitemap.nullable(),
    pages: z.array(UrlStatus).max(50),
  }),
  z.strictObject({ connected: z.literal(false) }),
  Refused,
])

export type GoogleConnectRequest = z.infer<typeof GoogleConnectRequest>
export type SearchConnection = z.infer<typeof SearchConnection>
export type SearchProperty = z.infer<typeof SearchProperty>
export type SearchTotals = z.infer<typeof SearchTotals>
export type SearchRow = z.infer<typeof SearchRow>
export type UrlStatus = z.infer<typeof UrlStatus>
export type ConnectGoogleOutput = z.infer<typeof ConnectGoogleOutput>
export type GetSearchPerformanceInput = z.infer<
  typeof GetSearchPerformanceInput
>
export type GetSearchPerformanceOutput = z.infer<
  typeof GetSearchPerformanceOutput
>
export type GetIndexingInput = z.infer<typeof GetIndexingInput>
export type GetIndexingOutput = z.infer<typeof GetIndexingOutput>
