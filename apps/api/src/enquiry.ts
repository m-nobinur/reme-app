import {
  ENQUIRY_PHOTOS_MAX,
  Enquiry,
  QUOTE_NOT_SENT_PATH,
  QUOTE_SENT_PATH,
  QUOTE_TRAP_FIELD,
  type ServerMessage,
  UPLOAD_MAX_BYTES,
} from "@workspace/contracts"
import {
  deliveries,
  deployments,
  orgOpen,
  resolveDomainHost,
  resolveOrgBySlug,
  type Tenancy,
} from "@workspace/db"
import { enquiryPhotoKey, sniff } from "./assets.ts"
import { failure } from "./http.ts"
import type { Limiter } from "./limit.ts"
import { factValue } from "./onboarding.ts"
import { readFacts } from "./workspace.ts"

/**
 * `POST /api/quote`: a quote request from a business's published website,
 * handed on by the router from the site's own host. No route reads an org
 * from client input (index.ts): the org is the one the request's hostname
 * names, which only the router's service binding can choose, so a call to
 * the API's own host finds no site.
 *
 * A plain form post, so every answer is a redirect back to the quote page:
 * `#quote-sent` or `#quote-not-sent`, which the page shows with CSS alone.
 * The enquiry lands in the chat as a card through the deliveries outbox,
 * which retries while a turn is running, and its event wakes the assistant
 * to offer a reply. Nothing a visitor typed is logged.
 *
 * shortcut: one limit per visitor and a honeypot, no per-site daily cap and
 * no challenge (Turnstile's free plan takes 10 hostnames a widget, too few
 * for custom domains); add both once spam shows in the owners' chats.
 */

/** Room for the form's own fields on top of the photos. */
const FORM_SLACK = 64 * 1024
const BODY_MAX = ENQUIRY_PHOTOS_MAX * UPLOAD_MAX_BYTES + FORM_SLACK
/** A question's key, as the contract's `QuoteField` spells it, maybe with `_links`. */
const KEY = /^[a-z][a-z0-9_]{1,40}$/
const CONTACT = new Set(["name", "email", "phone"])
/** Wide enough to read a quote's photo, small enough to keep the bucket light. */
const PHOTO_WIDTH = 2000

const back = (request: Request, path: string) =>
  Response.redirect(new URL(path, request.url).toString(), 303)

/** `property_address` as a person reads it: "Property address". */
const spoken = (key: string) =>
  key.charAt(0).toUpperCase() + key.slice(1).replaceAll("_", " ")

/** The org a published, open site on this host belongs to, or null. */
async function siteOrg(
  kit: Tenancy,
  host: string,
  suffix: string
): Promise<string | null> {
  const orgId = host.endsWith(suffix)
    ? await resolveOrgBySlug(kit, host.slice(0, -suffix.length))
    : ((await resolveDomainHost(kit, host))?.orgId ?? null)
  if (!orgId) return null
  const live = await kit.withOrg({ orgId }, async (db) => {
    if (!(await orgOpen(db))) return false
    const [published] = await db
      .select({ id: deployments.siteId })
      .from(deployments)
      .limit(1)
    return Boolean(published)
  })
  return live ? orgId : null
}

/** Each question's label as the owner approved it, by key. */
async function labels(kit: Tenancy, orgId: string) {
  const form = await kit.withOrg({ orgId }, async (db) =>
    factValue(await readFacts(db), "quote.form")
  )
  return new Map(form?.fields.map((field) => [field.key, field.label]) ?? [])
}

/**
 * One photo, re-encoded to WebP so no bytes the visitor sent are stored or
 * served, and no location the camera wrote goes with it. Null for a file
 * that is too large, not an image, or one the decoder refuses.
 */
async function keepPhoto(
  env: Env,
  orgId: string,
  file: File
): Promise<string | null> {
  if (file.size > UPLOAD_MAX_BYTES) return null
  if (!sniff(new Uint8Array(await file.slice(0, 12).arrayBuffer()))) return null
  const encoded = await env.IMAGES?.input(file.stream())
    .transform({ width: PHOTO_WIDTH, fit: "scale-down" })
    .output({ format: "image/webp", quality: 82 })
    .catch(() => null)
  if (!encoded) return null
  const id = crypto.randomUUID()
  await env.SITES.put(
    enquiryPhotoKey(orgId, id),
    await new Response(encoded.image()).arrayBuffer(),
    { httpMetadata: { contentType: "image/webp" } }
  )
  return id
}

export async function receiveQuote(
  request: Request,
  env: Env,
  kit: Tenancy,
  limiter: Limiter | undefined
): Promise<Response> {
  const host = new URL(request.url).hostname
  // A browser's form post always declares its length; a body that does not
  // would reach the form parser with no cap.
  const declared = Number(request.headers.get("content-length") ?? Number.NaN)
  if (!(declared <= BODY_MAX)) return back(request, QUOTE_NOT_SENT_PATH)
  const visitor = request.headers.get("cf-connecting-ip") ?? "unknown"
  if (limiter && !(await limiter.limit({ key: `quote:${visitor}` })).success) {
    return back(request, QUOTE_NOT_SENT_PATH)
  }
  const form = await request.formData().catch(() => null)
  if (!form) return back(request, QUOTE_NOT_SENT_PATH)
  // A field only a script fills in: thank it and keep nothing.
  if (String(form.get(QUOTE_TRAP_FIELD) ?? "").trim()) {
    return back(request, QUOTE_SENT_PATH)
  }
  const orgId = await siteOrg(kit, host, env.SITE_HOST_SUFFIX)
  if (!orgId) {
    return failure(404, {
      class: "resource",
      code: "site.not_found",
      message: "No published website takes quote requests here.",
      detail: {},
    })
  }

  const label = await labels(kit, orgId)
  const said = new Map<string, string[]>()
  const files: File[] = []
  for (const [key, value] of form.entries()) {
    if (typeof value !== "string") {
      if (value.size > 0) files.push(value)
      continue
    }
    const text = value.trim()
    if (!text || CONTACT.has(key) || !KEY.test(key)) continue
    said.set(key, [...(said.get(key) ?? []), text])
  }
  const parsed = Enquiry.safeParse({
    id: crypto.randomUUID(),
    name: String(form.get("name") ?? "").trim(),
    email: String(form.get("email") ?? "").trim(),
    phone: String(form.get("phone") ?? "").trim() || undefined,
    answers: [...said].map(([key, values]) => {
      const question = key.replace(/_links$/, "")
      const named = label.get(question) ?? spoken(question)
      return {
        label: key === question ? named : `${named} (links)`,
        value: values.join(", "),
      }
    }),
    photos: [],
  })
  if (!parsed.success) return back(request, QUOTE_NOT_SENT_PATH)

  const kept: string[] = []
  for (const file of files.slice(0, ENQUIRY_PHOTOS_MAX)) {
    const id = await keepPhoto(env, orgId, file)
    if (id) kept.push(id)
  }
  const enquiry: Enquiry = { ...parsed.data, photos: kept }
  const missed = files.length - kept.length
  const message: Omit<ServerMessage, "id"> = {
    text: [
      "You have a new quote request from your website.",
      ...(missed > 0
        ? [
            `${missed} of their photos could not be kept: too large, too many or not a picture.`,
          ]
        : []),
    ],
    enquiry,
  }
  const delivery = {
    orgId,
    key: `enquiry:${enquiry.id}`,
    channel: "in_app" as const,
    message,
  }
  await kit.withOrg({ orgId }, (db) =>
    db
      .insert(deliveries)
      .values({
        orgId,
        key: delivery.key,
        channel: delivery.channel,
        payload: delivery,
      })
      .onConflictDoNothing()
  )
  // Unsent, the row waits for the orchestrator's hourly sweep.
  await env.DELIVERIES.send(delivery).catch(() =>
    console.error(JSON.stringify({ code: "enquiry.unsent", org_id: orgId }))
  )
  console.log(
    JSON.stringify({
      code: "enquiry.received",
      org_id: orgId,
      photos: kept.length,
      missed,
    })
  )
  return back(request, QUOTE_SENT_PATH)
}
