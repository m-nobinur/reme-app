import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { treeOf } from "./client"
import type { StaffMember } from "./types"

const SRC = fileURLToPath(new URL("../..", import.meta.url))

/**
 * The seam is one module or it is not a seam.
 *
 * A loader that reached past `source.ts` for one screen would still be reading
 * the previous implementation after the next swap, and nothing else in the repo
 * would notice.
 */
it("names an implementation in exactly one module", () => {
  const offenders = readdirSync(SRC, { recursive: true })
    .map(String)
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".test.ts"))
    .filter((file) => {
      const source = readFileSync(join(SRC, file), "utf8")
      return /from\s+"[^"]*\/client"|from\s+"\.\/client"/.test(source)
    })

  expect(offenders).toEqual(["lib/api/source.ts"])
})

/**
 * The `manager_staff_id` closure (§5.2).
 *
 * The rows arrive as a flat list ordered by staff code, so this is the only
 * thing standing between the API's answer and the reporting lines a page draws,
 * and no other suite can see it: a real session's directory is empty until
 * someone is hired.
 */
const member = (id: string, managerId: string | null): StaffMember => ({
  id,
  staffCode: id,
  displayName: id,
  kind: "agent",
  positionTitle: null,
  roleTitle: null,
  departmentName: null,
  managerId,
  status: "active",
})

it("hangs each row off its manager", () => {
  const shape = (nodes: ReturnType<typeof treeOf>): Record<string, unknown> =>
    Object.fromEntries(
      nodes.map((node) => [node.staff.id, shape(node.reports)])
    )

  expect(
    shape(
      treeOf([
        member("a", null),
        member("b", "a"),
        member("c", "b"),
        member("d", "a"),
      ])
    )
  ).toEqual({ a: { b: { c: {} }, d: {} } })
})

it("draws a row whose manager it cannot see rather than dropping it", () => {
  // A manager outside this org's rows is not a reason to hide someone from
  // their own directory: a tree with a branch missing is a misleading tree.
  const tree = treeOf([member("a", null), member("orphan", "not-in-this-org")])
  expect(tree.map((node) => node.staff.id)).toEqual(["a", "orphan"])
})

it("has no tree to draw when nobody has been hired", () => {
  expect(treeOf([])).toEqual([])
})
