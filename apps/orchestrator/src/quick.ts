import { type BuildLane, ChangeKind } from "@workspace/contracts"

/**
 * The lane a new assignment runs in, from its kind and the CoS's read of the
 * change. Only a revise of a live site can be quick: a first build has
 * nothing to edit. Anything unknown or missing runs the full lane, so a
 * wrong guess costs time, never a broken site.
 */
export function pickLane(
  kind: string,
  changeKind: unknown
): { lane: BuildLane; change_kind: ChangeKind | null } {
  const parsed = ChangeKind.safeParse(changeKind)
  const change = parsed.success ? parsed.data : null
  // shortcut: photo runs full until IG's one-slot regenerate exists; move it to QUICK then.
  const quick = kind === "site.revise" && QUICK.includes(change as ChangeKind)
  return { lane: quick ? "quick" : "full", change_kind: change }
}

const QUICK: readonly ChangeKind[] = ["copy", "style", "section"]
