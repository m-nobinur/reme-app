/**
 * Cloudflare Registrar and Stripe answers for the buy path. `CHECK_SANDBOX`
 * and the two extension schemas were captured read-only on 2026-10-16 from
 * the Reme account (`POST registrar-sandbox/domain-check`, `GET
 * registrar-sandbox/extensions/com`, `GET registrar/extensions/co.uk`),
 * verbatim apart from the domain names. The registration, zone, Workers
 * Custom Domain and Stripe answers are shaped from Cloudflare's OpenAPI spec
 * and Stripe's API reference, because recording them would create a
 * registration or move test money.
 */

export const ACCOUNT = "acct"
export const SANDBOX = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/registrar-sandbox`
export const LIVE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/registrar`

export const envelope = (result: unknown) => ({
  success: true,
  errors: [],
  messages: [],
  result,
})
export const failed = (code: number, message: string) => ({
  success: false,
  errors: [{ code, message }],
  messages: [],
  result: null,
})

/** The sandbox takes `.com` and `.net` only; `.co.uk` and `.uk` are live-only. */
export const CHECK_SANDBOX = envelope({
  domains: [
    {
      name: "sparkleclean.co.uk",
      registrable: false,
      tier: "standard",
      reason: "extension_not_supported_via_api",
    },
    {
      name: "sparkleclean-bristol.uk",
      registrable: false,
      tier: "standard",
      reason: "extension_not_supported_via_api",
    },
    {
      name: "sparklecleanbristol.com",
      registrable: true,
      tier: "standard",
      pricing: {
        currency: "USD",
        registration_cost: "10.46",
        renewal_cost: "10.46",
      },
    },
    {
      name: "taken.com",
      registrable: false,
      tier: "standard",
      reason: "domain_unavailable",
    },
  ],
})

const contact = {
  type: "object",
  required: ["phone", "email", "postal_info"],
  properties: {
    fax: { type: "string" },
    email: { type: "string" },
    phone: { type: "string" },
    postal_info: {
      type: "object",
      required: ["name", "address"],
      properties: {
        name: { type: "string" },
        address: {
          type: "object",
          required: ["street", "city", "state", "postal_code", "country_code"],
          properties: {
            city: { type: "string" },
            state: { type: "string" },
            street: { type: "string" },
            postal_code: { type: "string" },
            country_code: { type: "string" },
          },
        },
        organization: { type: "string" },
      },
    },
  },
}

export const EXTENSION_COM = envelope({
  metadata: { name: "com", tld: "com" },
  registration_schema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    required: ["domain_name"],
    properties: {
      domain_name: { type: "string", minLength: 1 },
      years: { type: "integer", minimum: 1, maximum: 10, default: 1 },
      privacy_mode: {
        type: "string",
        enum: ["off", "redaction"],
        default: "redaction",
      },
      auto_renew: { type: "boolean", default: false },
      contacts: {
        type: "object",
        required: ["registrant"],
        properties: { registrant: contact },
        additionalProperties: false,
      },
      acknowledgements: { type: "object", properties: {} },
    },
    additionalProperties: false,
  },
  transfer_schema: {},
})

const types = [
  ["LTD", "UK Limited Company"],
  ["PLC", "UK Public Limited Company"],
  ["LLP", "UK Limited Liability Partnership"],
  ["IP", "UK Industrial/Provident Registered Company"],
  ["IND", "UK Individual (representing self)"],
  ["STRA", "UK Sole Trader"],
  ["FIND", "Non-UK Individual (representing self)"],
  ["PTNR", "UK Partnership"],
  ["SCH", "UK School"],
  ["RCHAR", "UK Registered Charity"],
  ["GOV", "UK Government Body"],
  ["CRC", "UK Corporation by Royal Charter"],
  ["STAT", "UK Statutory Body"],
  ["OTHER", "UK Entity (other)"],
  ["FCORP", "Non-UK Corporation"],
  ["FOTHER", "Non-UK Entity (other)"],
]

export const EXTENSION_CO_UK = envelope({
  metadata: { name: "co.uk", tld: "uk" },
  registration_schema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    required: ["domain_name", "contact_extensions"],
    properties: {
      domain_name: { type: "string", minLength: 1 },
      years: { type: "integer", minimum: 1, maximum: 10, default: 1 },
      privacy_mode: {
        type: "string",
        enum: ["off", "redaction"],
        default: "redaction",
      },
      auto_renew: { type: "boolean", default: false },
      contacts: {
        type: "object",
        required: ["registrant"],
        properties: {
          registrant: {
            ...contact,
            properties: {
              ...contact.properties,
              postal_info: {
                ...contact.properties.postal_info,
                required: ["name", "address", "organization"],
              },
            },
          },
        },
        additionalProperties: false,
      },
      acknowledgements: { type: "object", properties: {} },
      contact_extensions: {
        type: "object",
        properties: {
          registrant_type: {
            title: "Registrant Type",
            oneOf: types.map(([c, title]) => ({
              type: "string",
              const: c,
              title,
            })),
          },
          company_number: {
            type: "string",
            title: "Company Number",
            description:
              "Required when registrant_type is LTD, PLC, LLP, IP, SCH, or RCHAR",
          },
        },
        additionalProperties: false,
        required: ["registrant_type"],
        allOf: [
          {
            if: {
              required: ["registrant_type"],
              properties: {
                registrant_type: {
                  enum: ["LTD", "PLC", "LLP", "IP", "SCH", "RCHAR"],
                },
              },
            },
            // biome-ignore lint/suspicious/noThenProperty: JSON Schema's own keyword, as Cloudflare returns it
            then: { required: ["company_number"] },
          },
        ],
      },
    },
    additionalProperties: false,
  },
  transfer_schema: {},
})

/** The answer for an extension the sandbox does not take (captured, `co.uk`). */
export const EXTENSION_UNSUPPORTED = failed(
  10000,
  "Extension is not supported by the API"
)

const workflowStatus = (
  state: string,
  completed: boolean,
  name: string,
  error?: unknown
) =>
  envelope({
    state,
    completed,
    context: { domain_name: name },
    created_at: "2026-10-16T12:00:00Z",
    updated_at: "2026-10-16T12:00:05Z",
    links: {
      self: `/accounts/${ACCOUNT}/registrar/registrations/${name}/registration-status`,
      resource: `/accounts/${ACCOUNT}/registrar/registrations/${name}`,
    },
    ...(error ? { error } : { error: null }),
  })

export const REG_PENDING = (name: string) =>
  workflowStatus("in_progress", false, name)
export const REG_SUCCEEDED = (name: string) =>
  workflowStatus("succeeded", true, name)
export const REG_FAILED = (name: string) =>
  workflowStatus("failed", true, name, {
    code: "registry_rejected",
    message: "Registry rejected the request.",
  })

export const REGISTRATION = (name: string, autoRenew = true) =>
  envelope({
    domain_name: name,
    status: "active",
    created_at: "2026-10-16T12:00:05Z",
    expires_at: "2027-10-16T12:00:05Z",
    auto_renew: autoRenew,
    privacy_mode: "redaction",
    locked: true,
  })

export const NOT_FOUND = failed(10006, "Registration not found")

export const ZONE = (id: string, name: string) =>
  envelope({ id, name, status: "pending" })

export const WORKER_DOMAIN = (hostname: string, zoneId: string) =>
  envelope({
    id: `wd-${hostname}`,
    cert_id: "00000000-0000-4000-8000-000000000000",
    environment: "production",
    zone_id: zoneId,
    zone_name: hostname.replace(/^www\./, ""),
    hostname,
    service: "reme-router",
    previews_enabled: false,
    enabled: true,
  })

// Stripe

export const PI = (
  status: string,
  overrides: Record<string, unknown> = {}
) => ({
  id: "pi_123",
  object: "payment_intent",
  status,
  amount: 1200,
  amount_capturable: status === "requires_capture" ? 1200 : 0,
  currency: "gbp",
  customer: "cus_123",
  payment_method: "pm_123",
  capture_method: "manual",
  metadata: { domain_id: "dom" },
  ...overrides,
})

export const STRIPE_MISSING = {
  error: {
    code: "resource_missing",
    type: "invalid_request_error",
    message: "No such product: 'reme_domain_com'",
  },
}

export const SUBSCRIPTION = {
  id: "sub_123",
  object: "subscription",
  status: "active",
  metadata: { domain_id: "dom" },
}

export const INVOICE = {
  id: "in_123",
  object: "invoice",
  hosted_invoice_url: "https://invoice.stripe.com/i/acct_x/test_abc",
  next_payment_attempt: 1_817_000_000,
}
