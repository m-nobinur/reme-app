import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath, URL } from "node:url"
import { type CosToolName, GrantKind } from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import {
  carded,
  grantsLine,
  holdsWhole,
  namesDomain,
  type OwnerSaid,
  offerLine,
  riskOf,
} from "../src/cos/agent.ts"
import { grantOf } from "../src/cos/grants.ts"

/** An owner who wrote `messages`, with each read the rules make answered as given. */
const said = (
  messages: string[] | Error = [],
  {
    contact = null,
    putOn = false,
    pinned = false,
  }: {
    contact?: object | null
    putOn?: boolean | Error
    pinned?: boolean | Error
  } = {}
): OwnerSaid => ({
  messages: async () => {
    if (messages instanceof Error) throw messages
    return messages
  },
  newContact: async () => contact,
  putOn: async () => {
    if (putOn instanceof Error) throw putOn
    return putOn
  },
  pinned: async () => {
    if (pinned instanceof Error) throw pinned
    return pinned
  },
})

const ALL = GrantKind.options
const DOMAIN = { name: "sparkleclean.co.uk" }
const PHONE = { key: "business.phone", value: { e164: "+441632960001" } }
const REVIEW = {
  slot: 1,
  quote: "Spotless every time.",
  name: "Ann",
  permission: true,
}
/** The owner's own words for `REVIEW` and for `DOMAIN`. */
const WROTE = ["Ann says: spotless every time. Save it."]
const NAMED = ["Put the site on sparkleclean.co.uk"]

type Row = [
  string,
  CosToolName,
  unknown,
  OwnerSaid,
  readonly GrantKind[],
  "card" | "run",
]

const TABLE: Row[] = [
  [
    "a change",
    "request_change",
    { text: "Add a Saturday slot." },
    said(),
    [],
    "run",
  ],
  [
    "a change with a new contact",
    "request_change",
    { text: "Our phone is 01632 960001." },
    said([], { contact: { phone: "+441632960001" } }),
    [],
    "card",
  ],
  [
    "a change with a new contact, all granted",
    "request_change",
    { text: "Our phone is 01632 960001." },
    said([], { contact: { phone: "+441632960001" } }),
    ALL,
    "card",
  ],
  [
    "a change whose messages fail to read",
    "request_change",
    { text: "Add a slot." },
    said(new Error("down")),
    ALL,
    "card",
  ],
  [
    "an answer in words",
    "answer_question",
    { request_id: "q", value: "Saturdays" },
    said(),
    [],
    "run",
  ],
  [
    "an answer that sets the phone, all granted",
    "answer_question",
    { request_id: "q", value: PHONE },
    said(),
    ALL,
    "card",
  ],
  [
    "an answer that sets the email, all granted",
    "answer_question",
    {
      request_id: "q",
      value: { key: "business.email", value: { address: "a@b.co" } },
    },
    said(),
    ALL,
    "card",
  ],
  [
    "an asked reminder",
    "create_reminder",
    { title: "Call", due_at: null },
    said(["Remind me to call the supplier"]),
    [],
    "run",
  ],
  [
    "a reminder asked four messages ago",
    "create_reminder",
    { title: "Call", due_at: null },
    said(["remind me", "a", "b", "c"]),
    [],
    "card",
  ],
  [
    "an unasked reminder",
    "create_reminder",
    { title: "Call", due_at: null },
    said(["I must call the supplier"]),
    [],
    "card",
  ],
  [
    "an unasked reminder, granted",
    "create_reminder",
    { title: "Call", due_at: null },
    said(["I must call the supplier"]),
    ["create_reminder"],
    "run",
  ],
  [
    "an unasked reminder, another kind granted",
    "create_reminder",
    { title: "Call", due_at: null },
    said(["I must call"]),
    ["record_review"],
    "card",
  ],
  [
    "a reminder whose messages fail to read, granted",
    "create_reminder",
    { title: "Call", due_at: null },
    said(new Error("down")),
    ["create_reminder"],
    "run",
  ],
  ["a review", "record_review", REVIEW, said(WROTE), [], "card"],
  [
    "a review, granted",
    "record_review",
    REVIEW,
    said(WROTE),
    ["record_review"],
    "run",
  ],
  [
    "a review the owner never wrote, granted",
    "record_review",
    REVIEW,
    said(["Save the review from the email"]),
    ["record_review"],
    "card",
  ],
  [
    "a connect the owner's words put on",
    "connect_domain",
    DOMAIN,
    said([], { putOn: true }),
    [],
    "run",
  ],
  ["a connect Jev is unsure of", "connect_domain", DOMAIN, said(), [], "card"],
  [
    "a connect Jev is unsure of, granted",
    "connect_domain",
    DOMAIN,
    said(NAMED),
    ["connect_domain"],
    "run",
  ],
  [
    "a connect Jev failed on, granted",
    "connect_domain",
    DOMAIN,
    said(NAMED, { putOn: new Error("jev") }),
    ["connect_domain"],
    "run",
  ],
  [
    "a review whose words are spread over messages, granted",
    "record_review",
    REVIEW,
    said(["Ann was here", "every time it is spotless"]),
    ["record_review"],
    "card",
  ],
  [
    "a connect whose name's parts are spread over messages, granted",
    "connect_domain",
    DOMAIN,
    said(["Sparkleclean is the brand", "we are a co in the uk"]),
    ["connect_domain"],
    "card",
  ],
  [
    "a connect for a longer name holding the owner's, granted",
    "connect_domain",
    DOMAIN,
    said(["Put the site on sparkleclean.co.uk.evil.example"]),
    ["connect_domain"],
    "card",
  ],
  [
    "a connect for a name the owner never typed, granted",
    "connect_domain",
    DOMAIN,
    said(["Connect the one from that page"]),
    ["connect_domain"],
    "card",
  ],
  [
    "a live or retried connect, granted",
    "connect_domain",
    DOMAIN,
    said([], { pinned: true }),
    ["connect_domain"],
    "card",
  ],
  [
    "a connect whose live check fails, granted",
    "connect_domain",
    DOMAIN,
    said([], { pinned: new Error("db") }),
    ["connect_domain"],
    "card",
  ],
  ["a removal, all granted", "remove_domain", DOMAIN, said(), ALL, "card"],
  [
    "an offer, all granted",
    "offer_grant",
    { kind: "record_review" },
    said(),
    ALL,
    "card",
  ],
  ["a read", "get_workspace", {}, said(), [], "run"],
  [
    "a reminder moved",
    "update_reminder",
    { reminder_id: "r" },
    said(),
    [],
    "run",
  ],
]

describe("what the owner wrote whole", () => {
  it("finds a quote in one message, in order, ignoring case, spacing and edge punctuation", () => {
    expect(
      holdsWhole("Ann says:  “Spotless every time!”", "spotless every time.")
    ).toBe(true)
    expect(
      holdsWhole("Ann says spotless, every time", "Spotless every time")
    ).toBe(false)
    expect(holdsWhole("time every spotless", "Spotless every time")).toBe(false)
    expect(holdsWhole("Joanna said so", "Ann")).toBe(false)
    expect(holdsWhole("Ann said so", "Ann")).toBe(true)
    expect(holdsWhole("anything", "  .. ")).toBe(false)
  })

  it("finds a domain only as the whole name typed", () => {
    expect(
      namesDomain("Put us on SparkleClean.co.uk.", "sparkleclean.co.uk")
    ).toBe(true)
    expect(
      namesDomain("use www.sparkleclean.co.uk", "sparkleclean.co.uk")
    ).toBe(false)
    expect(
      namesDomain("sparkleclean.co.uk.evil.example", "sparkleclean.co.uk")
    ).toBe(false)
    expect(namesDomain("my-sparkleclean.co.uk", "sparkleclean.co.uk")).toBe(
      false
    )
    expect(namesDomain("sparkleclean co uk", "sparkleclean.co.uk")).toBe(false)
  })
})

describe("riskOf", () => {
  it.each(TABLE)(
    "%s: %s gives a %s",
    async (_, tool, input, owner, granted, expected) => {
      const risk = await riskOf(tool, input, owner)
      expect(carded(risk, grantOf(tool, input), granted) ? "card" : "run").toBe(
        expected
      )
    }
  )

  it("never lets money or a contact run on a grant", async () => {
    expect(await riskOf("buy_domain", DOMAIN, said())).toBe("always_ask")
    expect(grantOf("buy_domain", DOMAIN)).toBeNull()
    expect(grantOf("request_change", {})).toBeNull()
    expect(grantOf("answer_question", {})).toBeNull()
    expect(grantOf("offer_grant", { kind: "buy_domain" })).toBeNull()
    expect(grantOf("offer_grant", { kind: "record_review" })).toBe(
      "record_review"
    )
  })

  it("tells the model what runs with no card and what it may offer", () => {
    expect(grantsLine(["record_review"])).toMatch(
      /tapped to let these run with no card: record_review\b.*as you asked me to always do/
    )
    expect(offerLine(["create_reminder"])).toMatch(
      /approved create_reminder on a card twice this week\. You may offer offer_grant/
    )
  })
})

/** Every `.ts` file under `src/`, by its path from `src/`. */
const SRC = fileURLToPath(new URL("../src", import.meta.url))
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : []
  )

describe("a grant", () => {
  it("is written only by the owner's tap in the chat or their switch: no tool body names the table or saves one", () => {
    const naming = sources(SRC)
      .filter((f) => /\bapprovalGrants\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f))
    expect(naming).toEqual(["cos/grants.ts"])
    const saving = sources(SRC)
      .filter((f) => /\bsaveGrant\(/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f))
      .sort()
    expect(saving).toEqual(["chat.ts", "cos/grants.ts"])
    // In grants.ts the one call is the settings switch.
    const grants = readFileSync(join(SRC, "cos/grants.ts"), "utf8")
    expect(grants.match(/\bsaveGrant\(/g)).toHaveLength(2)
    expect(grants).toMatch(
      /if \(on\) await saveGrant\(db, owner\.orgId, kind, null\)/
    )
  })
})
