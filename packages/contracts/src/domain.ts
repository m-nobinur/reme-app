import { z } from "zod"
import { Hostname } from "./site.ts"
import { Text } from "./text.ts"

// Custom domains, connect path (ADR-032). An owner's existing domain points
// at the site through records they add at their DNS provider. Nothing here
// carries an org id or a Cloudflare id: the CoS reads these shapes.

/** A zone apex: lower-case, punycode for anything not ASCII, at most 253 characters. */
export const DomainName = Hostname

/**
 * Where a domain is in connecting. `awaiting_dns` waits for the owner's
 * records, `verifying` has seen them and waits on the certificate.
 */
export const DomainState = z.enum([
  "awaiting_dns",
  "verifying",
  "active",
  "failed",
  "removed",
])

/** How the domain came to be the org's. A later origin is an added value. */
export const DomainOrigin = z.enum(["connected"])

/** One record the owner adds, or one that is in the way. */
export const DnsRecord = z.strictObject({
  type: z.enum(["A", "AAAA", "ALIAS", "CAA", "CNAME", "TXT"]),
  name: z.string().min(1).max(253),
  value: z.string().min(1).max(512),
})

/**
 * One check of a domain, in the order dub's verify route decides: the host
 * is unknown to the edge, the check itself failed, a record is in the way,
 * the host is not yet verified, the records point elsewhere, and then the
 * certificate. Only `valid` lets the domain go live.
 */
export const DomainCheck = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("not_found") }),
  z.strictObject({ status: z.literal("unknown_error") }),
  z.strictObject({
    status: z.literal("conflicting_record"),
    conflicts: z.array(DnsRecord).min(1).max(10),
  }),
  z.strictObject({ status: z.literal("pending_verification") }),
  z.strictObject({ status: z.literal("invalid_configuration") }),
  z.strictObject({ status: z.literal("pending_certificate") }),
  z.strictObject({ status: z.literal("valid") }),
])

/**
 * The owner's DNS provider as detected. `settings_url` is only ever one of
 * our own allowlisted links, never a URL a domain's DNS named, and a plain
 * string so a tool output shows the model no `uri` format.
 */
export const DomainProvider = z.strictObject({
  name: Text(80),
  settings_url: z
    .string()
    .max(300)
    .regex(/^https:\/\/[^\s]+$/)
    .optional(),
})

export type DomainName = z.infer<typeof DomainName>
export type DomainState = z.infer<typeof DomainState>
export type DomainOrigin = z.infer<typeof DomainOrigin>
export type DnsRecord = z.infer<typeof DnsRecord>
export type DomainCheck = z.infer<typeof DomainCheck>
export type DomainProvider = z.infer<typeof DomainProvider>
