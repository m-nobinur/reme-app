import {
  ApprovalGrantSwitch,
  ApprovalGrants,
  type CosToolName,
  GrantKind,
  type OfferGrantInput,
  type OfferGrantOutput,
} from "@workspace/contracts"
import {
  approvalGrants,
  eq,
  type OrgScopedDb,
  rootStaffId,
  type Tenancy,
} from "@workspace/db"
import type { Owner } from "../changes.ts"
import { invalid, readBody } from "../http.ts"
import type { ToolContext } from "./tools.ts"

/**
 * What the owner lets the Chief of Staff do with no card (S5). A grant is
 * written only here, from the owner's tap on a card (`chat.ts`) or their
 * switch on the settings page; no tool reaches `saveGrant`.
 */

/** The kind a tool's call counts as, or null for a tool that is never granted. */
export const grantOf = (tool: CosToolName, input: unknown): GrantKind | null =>
  tool === "offer_grant"
    ? (GrantKind.safeParse((input as { kind?: unknown } | null)?.kind).data ??
      null)
    : (GrantKind.safeParse(tool).data ?? null)

/** The kinds the owner lets run with no card, read fresh, so a switch counts on the next action. */
export async function grantedKinds(db: OrgScopedDb): Promise<GrantKind[]> {
  const rows = await db
    .select({ kind: approvalGrants.kind })
    .from(approvalGrants)
  return GrantKind.options.filter((k) => rows.some((r) => r.kind === k))
}

/** Saves the owner's grant. `sourceApproval` is the card's approval id, null for a switch. */
export async function saveGrant(
  db: OrgScopedDb,
  orgId: string,
  kind: GrantKind,
  sourceApproval: string | null
): Promise<void> {
  const by = await rootStaffId(db)
  if (!by) throw new Error("grants: the org has no owner staff row")
  await db
    .insert(approvalGrants)
    .values({ orgId, kind, grantedByStaffId: by, sourceApproval })
    .onConflictDoNothing()
}

/**
 * `offer_grant`'s body, run after the owner's yes on its card. It only reads:
 * the tap on the card saved the grant, and a yes that saved none (a typed
 * one) is refused, so the model never says a grant exists that does not.
 */
export async function offerGrant(
  { kit, owner }: Pick<ToolContext, "kit" | "owner">,
  { kind }: OfferGrantInput
): Promise<OfferGrantOutput> {
  const granted = await kit.withOrg({ orgId: owner.orgId }, grantedKinds)
  return granted.includes(kind)
    ? { outcome: "granted", kind }
    : {
        outcome: "refused",
        error: {
          class: "validation",
          code: "grant.not_tapped",
          message:
            "Nothing was saved: only the owner's tap on the card's button saves it. Say it still asks first.",
        },
      }
}

async function grantsView(db: OrgScopedDb): Promise<ApprovalGrants> {
  const rows = await db
    .select({ kind: approvalGrants.kind, at: approvalGrants.grantedAt })
    .from(approvalGrants)
  return ApprovalGrants.parse({
    grants: GrantKind.options.map((kind) => {
      const row = rows.find((r) => r.kind === kind)
      return { kind, on: !!row, granted_at: row?.at.toISOString() ?? null }
    }),
  })
}

/** The settings page: `GET /approval-grants` and the owner's switch, `POST /approval-grants`. */
export async function grantsRoute(
  request: Request,
  kit: Tenancy,
  owner: Owner
): Promise<Response | null> {
  const at = { orgId: owner.orgId }
  if (request.method === "GET") {
    return Response.json(await kit.withOrg(at, grantsView))
  }
  if (request.method !== "POST") return null
  const parsed = ApprovalGrantSwitch.safeParse(await readBody(request))
  if (!parsed.success) return invalid(parsed.error.issues)
  const { kind, on } = parsed.data
  return Response.json(
    await kit.withOrg(at, async (db) => {
      if (on) await saveGrant(db, owner.orgId, kind, null)
      else await db.delete(approvalGrants).where(eq(approvalGrants.kind, kind))
      return grantsView(db)
    })
  )
}
