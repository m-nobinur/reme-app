// @vitest-environment happy-dom
import type { ApprovalTarget } from "@workspace/contracts"
import { ApprovalItem } from "@workspace/ui/components/live-panel"
import fc from "fast-check"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { Decidable } from "@/panel/workspace-panel"
import { apiSource } from "./api/client"

/**
 * Server functions run in place: the validator, then the handler, exactly as
 * written in `server.ts`, with no RPC between them. What a panel button
 * sends is therefore what reaches `apps/api`.
 */
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (input: unknown) => input
    const builder = {
      validator(next: (input: unknown) => unknown) {
        validate = next
        return builder
      },
      handler:
        (run: (context: { data: unknown }) => unknown) =>
        (options?: { data?: unknown }) =>
          Promise.resolve().then(() => run({ data: validate(options?.data) })),
    }
    return builder
  },
}))
vi.mock("@tanstack/react-start/server", () => ({
  getCookie: (name: string) => (name === "wos-session" ? "sealed" : undefined),
  setCookie: () => undefined,
  getRequestProtocol: () => "https",
}))

/**
 * The approval model rests on one property (§20): a decision the owner
 * sends is bound to the revision the owner was shown, and nothing else.
 *
 * Generated here: a workspace of approvals over arbitrary revisions, beside a
 * live revision that differs from them. Each approval goes through the real
 * read (`/workspace` to the panel's item), is rendered by the panel's own
 * wired row, and is approved by pressing its button, which runs the
 * `decideApproval` server function and the api client's write. The property
 * fails on any decision whose revision is not the one on screen next to the
 * button, and on any approve button enabled with no revision bound.
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
  { minLength: 1, maxLength: 4, selector: (approval) => approval.approval_id }
)

let posted: { path: string; body: { revision_id: string } }[] = []
let body: unknown = null

beforeEach(() => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
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
      if (url.pathname === "/org") {
        return Response.json({
          org_id: ORG,
          slug: "fictional-co",
          name: "Fictional Co",
          created_at: AT,
        })
      }
      if (url.pathname === "/workspace") return Response.json(body)
      // The preview is not what this is about: the row shows its error line.
      return new Response(null, { status: 404 })
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The revision the row is bound to: read off the page, never printed on it. */
const revisionOn = (container: HTMLElement) =>
  container.querySelector("[data-revision]")?.getAttribute("data-revision")

const noop = () => undefined

it("sends only the revision shown beside Approve, pressed in the panel", async () => {
  await fc.assert(
    fc.asyncProperty(
      approvals,
      fc.uuid({ version: 4 }),
      async (generated, live) => {
        body = {
          site: {
            host: null,
            url: null,
            live: {
              revision_id: live,
              version: 1000,
              assignment_id: crypto.randomUUID(),
            },
          },
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
          assistant_name: null,
          reminders: { notes: [], derived: [] },
        }
        const workspace = await apiSource.pollWorkspace(null)
        if (workspace === "unchanged") throw new Error("no workspace read")

        for (const item of workspace.attention) {
          if (item.kind !== "approval") continue
          if (item.request.target.kind !== "revision") {
            throw new Error("a non-revision approval reached the panel")
          }
          const container = document.createElement("div")
          document.body.appendChild(container)
          const root = createRoot(container)
          await act(async () => {
            root.render(
              createElement(Decidable, {
                item,
                refresh: async () => undefined,
                announce: noop,
              })
            )
          })
          const approve = [...container.querySelectorAll("button")].find(
            (button) => button.textContent?.startsWith("Approve and publish")
          )
          expect(approve?.textContent).toBe("Approve and publish")
          expect(approve?.disabled).toBe(false)
          const shown = revisionOn(container)

          posted = []
          await act(async () => {
            approve?.click()
          })
          await vi.waitFor(() => expect(posted).toHaveLength(1))
          const sent = posted[0]
          // The revision that went out is the one on screen and the one the
          // row was read with, never the live one or another approval's.
          expect(sent?.path).toBe(
            `/approvals/${item.request.approval_id}/decision`
          )
          expect(sent?.body.revision_id).toBe(shown)
          expect(sent?.body.revision_id).toBe(item.request.target.revision_id)
          if (live !== item.request.target.revision_id) {
            expect(sent?.body.revision_id).not.toBe(live)
          }
          await act(async () => root.unmount())
          container.remove()
        }
      }
    ),
    { numRuns: 60 }
  )
  // Up to 240 renders: 0.1 s alone, past 5 s when the pre-push hook runs every suite at once.
}, 30_000)

it("disables Approve for anything but a revision", () => {
  fc.assert(
    fc.property(target, (generated) => {
      const html = renderToStaticMarkup(
        createElement(ApprovalItem, {
          target: generated,
          rationale: "r",
          expiresAt: EXPIRES,
          onExpiry: "o",
          preview: "loading",
          onApprove: noop,
          onAskForChanges: noop,
        })
      )
      // The attribute, not the class: every button's class names `disabled:`.
      const enabled =
        !/<button(?=[^>]*\sdisabled="")[^>]*>Approve and publish/.test(html)
      expect(enabled).toBe(generated.kind === "revision")
    })
  )
})
