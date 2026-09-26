import type { ApprovalTarget } from "@workspace/contracts"
import {
  ApprovalItem,
  approvalDecision,
} from "@workspace/ui/components/live-panel"
import fc from "fast-check"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { apiSource } from "./api/client"

vi.mock("@tanstack/react-start/server", () => ({
  getCookie: () => "sealed",
}))

/**
 * The approval model rests on one property (§20, K2): a decision the owner
 * sends is bound to the revision the owner was shown, and nothing else.
 *
 * Generated here: a workspace of approvals over arbitrary revisions, beside a
 * live revision that differs from them. Each approval goes through the real
 * read (`/workspace` to the panel's item), is rendered as the panel renders
 * it, and is approved through the real write. The property fails on any
 * accepted decision whose revision is not the one on screen next to the
 * button, and on any approve button that is enabled with no revision bound.
 */

const ORG = "00000000-0000-4000-8000-000000000001"
const DEV = "00000000-0000-4000-8000-000000000002"
const AT = "2026-09-26T10:00:00.000Z"
const EXPIRES = "2026-09-29T10:00:00.000Z"

const target = fc.oneof(
  fc
    .uuid({ version: 4 })
    .map((revision_id): ApprovalTarget => ({ kind: "revision", revision_id })),
  fc.constant<ApprovalTarget>({
    kind: "domain",
    hostname: "fictional.example.invalid",
  }),
  fc.constant<ApprovalTarget>({
    kind: "spend",
    amount_usd: 12,
    currency: "USD",
  })
)

const approvals = fc.uniqueArray(
  fc.record({
    approval_id: fc.uuid({ version: 4 }),
    assignment_id: fc.uuid({ version: 4 }),
    target,
    version: fc.integer({ min: 1, max: 999 }),
  }),
  { minLength: 1, maxLength: 5, selector: (approval) => approval.approval_id }
)

let posted: { path: string; body: unknown }[] = []
let body: unknown = null

beforeEach(() => {
  process.env.REME_API_URL = "https://api.test"
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        const sent = JSON.parse(String(init.body)) as { revision_id: string }
        posted.push({ path: url.pathname, body: sent })
        return Response.json({
          approval_id: url.pathname.split("/")[2],
          org_id: ORG,
          decision: "approved",
          target: { kind: "revision", revision_id: sent.revision_id },
          decided_by: { kind: "owner_session", user_id: "u", session_id: "s" },
          decided_at: AT,
        })
      }
      if (url.pathname === "/staff") return Response.json({ staff: [] })
      return Response.json(body)
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** What the item shows beside its button: the version and the short id. */
function shown(html: string) {
  return {
    shortId: /ID ([0-9a-f]{8})/.exec(html)?.[1] ?? null,
    version: Number(/Approve and publish v(\d+)/.exec(html)?.[1]),
    // The attribute, not the class: every button's class names `disabled:`.
    enabled: !/<button(?=[^>]*\sdisabled="")[^>]*>Approve and publish/.test(
      html
    ),
  }
}

const noop = () => undefined

it("sends only the revision shown beside Approve", async () => {
  await fc.assert(
    fc.asyncProperty(
      approvals,
      fc.uuid({ version: 4 }),
      async (generated, live) => {
        posted = []
        body = {
          site: { host: null, live: { revision_id: live, version: 1000 } },
          builds: [],
          attention: generated.map((approval) => ({
            kind: "approval",
            version: approval.version,
            request: {
              approval_id: approval.approval_id,
              org_id: ORG,
              assignment_id: approval.assignment_id,
              requested_by_staff_id: DEV,
              approver_staff_id: DEV,
              action_kind: "site.publish",
              target: approval.target,
              rationale: "A new version is ready.",
              requested_at: AT,
              expires_at: EXPIRES,
            },
          })),
          missing_facts: [],
        }
        const workspace = await apiSource.pollWorkspace(ORG, null)
        if (workspace === "unchanged") throw new Error("no workspace read")

        for (const item of workspace.attention) {
          if (item.kind !== "approval") continue
          const html = renderToStaticMarkup(
            createElement(ApprovalItem, {
              target: item.request.target,
              version: item.version,
              rationale: item.detail,
              expiresAt: item.request.expires_at,
              onExpiry: item.onExpiry,
              preview: "loading",
              onApprove: noop,
              onAskForChanges: noop,
            })
          )
          const screen = shown(html)
          const decision = approvalDecision(item.request.target, "approved")

          if (item.request.target.kind !== "revision") {
            expect(screen.enabled).toBe(false)
            expect(decision).toBeNull()
            continue
          }
          expect(screen.enabled).toBe(true)
          expect(screen.version).toBe(item.version)
          expect(decision).not.toBeNull()
          if (!decision) continue

          const before = posted.length
          await apiSource.decideApproval(
            ORG,
            item.request.approval_id,
            decision.revision_id,
            decision.decision
          )
          const sent = posted.at(before)?.body as { revision_id: string }
          // The revision that went out is the one the item was read with and
          // the one on screen, never the live one or another approval's.
          expect(sent.revision_id).toBe(item.request.target.revision_id)
          expect(sent.revision_id.slice(0, 8)).toBe(screen.shortId)
          if (live !== item.request.target.revision_id) {
            expect(sent.revision_id).not.toBe(live)
          }
        }
      }
    ),
    { numRuns: 200 }
  )
})

it("disables Approve for anything but a revision", () => {
  fc.assert(
    fc.property(target, (generated) => {
      const html = renderToStaticMarkup(
        createElement(ApprovalItem, {
          target: generated,
          version: 1,
          rationale: "r",
          expiresAt: EXPIRES,
          onExpiry: "o",
          preview: "loading",
          onApprove: noop,
          onAskForChanges: noop,
        })
      )
      expect(shown(html).enabled).toBe(generated.kind === "revision")
    })
  )
})
