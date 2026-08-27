import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { mockSource } from "./mock"
import type { OrgNode } from "./types"

const SRC = fileURLToPath(new URL("../..", import.meta.url))

const orgId = async (slug: string) => {
  const orgs = await mockSource.orgs()
  const found = orgs.find((org) => org.slug === slug)
  if (!found) {
    throw new Error(`No fixture organisation ${slug}`)
  }
  return found.id
}

/**
 * The seam is one module or it is not a seam.
 *
 * "Swapping to the real client is one provider change" is only true while
 * `source.ts` is the sole importer of an implementation. A loader that reaches
 * past it for one screen would leave that screen on mocks after the swap, and
 * nothing else in the repo would notice.
 */
it("names an implementation in exactly one module", () => {
  const offenders = readdirSync(SRC, { recursive: true })
    .map(String)
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".test.ts"))
    .filter((file) => {
      const source = readFileSync(join(SRC, file), "utf8")
      return /from\s+"[^"]*\/mock"|from\s+"\.\/mock"/.test(source)
    })

  expect(offenders).toEqual(["lib/api/source.ts"])
})

/**
 * The org tree brightclean has to render, from §5.2. Written out rather than
 * derived from the same code that builds it, so a bug in `treeOf` cannot agree
 * with the expectation.
 */
const BRIGHTCLEAN_TREE = {
  "Dana Reyes": {
    Maya: {
      Alex: {},
      Nora: {},
      Jamie: {},
      Daniel: { Priya: {}, Sam: {} },
    },
  },
}

const shape = (nodes: OrgNode[]): Record<string, unknown> =>
  Object.fromEntries(
    nodes.map((node) => [node.staff.displayName, shape(node.reports)])
  )

it("renders the brightclean org tree", async () => {
  const tree = await mockSource.orgTree(await orgId("brightclean"))
  expect(shape(tree)).toEqual(BRIGHTCLEAN_TREE)

  // One root, and it is the owner's human proxy record (§5.2).
  expect(tree).toHaveLength(1)
  expect(tree[0]?.staff.kind).toBe("human")
  expect(tree[0]?.staff.staffCode).toBe("OWN-001")

  // Every agent under it carries the role and department it was hired into,
  // because a directory that shows a blank role is not a directory.
  const cos = tree[0]?.reports[0]
  expect(cos?.staff.displayName).toBe("Maya")
  expect(cos?.staff.roleTitle).toBe("Chief of Staff")
  expect(cos?.staff.departmentName).toBe("Operations")

  // The paused row is still in the tree, and still says it is paused.
  const sam = cos?.reports
    .flatMap((node) => node.reports)
    .find((node) => node.staff.displayName === "Sam")
  expect(sam?.staff.status).toBe("paused")
})

it("gives emptyco an owner and nothing else", async () => {
  const id = await orgId("emptyco")
  expect(await mockSource.staff(id)).toEqual([])
  expect(await mockSource.orgTree(id)).toEqual([])
  expect(await mockSource.attention(id)).toEqual([])
  expect(await mockSource.approvals(id)).toEqual([])
  expect(await mockSource.pipeline(id)).toEqual([])
  expect(await mockSource.activity(id)).toEqual([])
  expect((await mockSource.profile(id)).facts).toEqual([])
})

it("keeps the business profile on canonical facts", async () => {
  const { facts } = await mockSource.profile(await orgId("brightclean"))
  const price = facts.find(
    (fact) => fact.key === "pricing.standard_clean_hourly" && fact.version === 2
  )

  // The screen reads the current version; the superseded one is still present
  // so the history section has something to show (§10.2).
  expect(price?.valid_to).toBeNull()
  expect(
    facts.filter((fact) => fact.key === "pricing.standard_clean_hourly")
  ).toHaveLength(2)
  // Provenance travels with the value. A fact with no source is a claim.
  expect(price?.provenance.source).toBe("owner_stated")
})

it("answers an approval once, and is safe to answer twice", async () => {
  const id = await orgId("brightclean")
  const before = await mockSource.approvals(id)
  const target = before[0]
  if (!target) {
    throw new Error("brightclean has no approvals to decide")
  }

  await mockSource.decideApproval(id, target.request.approval_id, "approved")
  await mockSource.decideApproval(id, target.request.approval_id, "approved")

  const after = await mockSource.approvals(id)
  expect(after).toHaveLength(before.length - 1)
  // It leaves the dashboard as well, so the same decision is not asked twice.
  expect(
    (await mockSource.attention(id)).some(
      (item) => item.id === target.request.approval_id
    )
  ).toBe(false)
})

it("refuses to decide an approval another organisation holds", async () => {
  const brightclean = await orgId("brightclean")
  const mopandbucket = await orgId("mopandbucket")
  const [held] = await mockSource.approvals(brightclean)
  if (!held) {
    throw new Error("brightclean has no approvals left to test with")
  }

  await mockSource.decideApproval(
    mopandbucket,
    held.request.approval_id,
    "approved"
  )

  expect(
    (await mockSource.approvals(brightclean)).some(
      (item) => item.request.approval_id === held.request.approval_id
    )
  ).toBe(true)
})
