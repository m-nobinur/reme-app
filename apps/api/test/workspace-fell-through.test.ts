import { BuildSummary } from "@workspace/contracts"
import { type Tenancy, tenancy } from "@workspace/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { readBuilds } from "../src/workspace.ts"
import { type Owner, owner, seed } from "./owner-fixture.ts"

const url = process.env.DATABASE_URL

/**
 * A quick edit that handed its change on (QE4) reads as the fuller lane it
 * runs in, with the flag the panel says it by. The orchestrator logs two
 * hand-offs: `quick.fell_through` for the Developer, and `model.switched`
 * with that reason when the section lane moves on to the build model.
 */
describe.skipIf(!url)("a quick edit that fell through, on /workspace", () => {
  const kit: Tenancy = tenancy(url as string, { max: 2 })
  let who: Owner

  beforeAll(async () => {
    who = await owner(kit, url as string, "fell")
  })
  afterAll(async () => {
    await kit.close()
  })

  const builds = () => kit.withOrg({ orgId: who.orgId }, (db) => readBuilds(db))

  it.each([
    ["quick.fell_through", { from: "copy", to: "section", reason: "apply" }],
    ["model.switched", { from: "a", to: "b", reason: "quick.fell_through" }],
  ])(
    "says so once its %s event is logged, and not before",
    async (type, payload) => {
      const s = seed(kit, who)
      const id = await s.assignment("implementing", { kind: "site.revise" })
      await s.event(id, "assignment.created", { lane: "quick" })
      const [before] = await builds()
      expect(before).toMatchObject({ lane: "quick" })
      expect(before?.fell_through).toBeUndefined()

      await s.event(id, type, payload)
      const [after] = await builds()
      expect(after).toMatchObject({ lane: "full", fell_through: true })
      BuildSummary.parse(after)
      // Done with this one, so the next case's build can write the site.
      await s.state(id, "published")
    }
  )

  it("leaves a model switch for any other reason, and a full build, alone", async () => {
    const s = seed(kit, who)
    const id = await s.assignment("implementing")
    await s.event(id, "assignment.created", { lane: "full" })
    await s.event(id, "model.switched", {
      from: "a",
      to: "b",
      reason: "provider.unavailable",
    })
    await s.event(id, "quick.fell_through", { reason: "gates" })
    const [build] = await builds()
    expect(build).toMatchObject({ lane: "full" })
    expect(build?.fell_through).toBeUndefined()
    await s.state(id, "published")
  })

  it("serves a change's label from its creation event, and none without one", async () => {
    const s = seed(kit, who)
    const id = await s.assignment("implementing", { kind: "site.revise" })
    await s.event(id, "assignment.created", {
      lane: "quick",
      label: "your hero title",
    })
    const [build] = await builds()
    expect(BuildSummary.parse(build)).toMatchObject({
      label: "your hero title",
    })
    await s.state(id, "published")
    const plain = await s.assignment("implementing")
    await s.event(plain, "assignment.created", { lane: "full" })
    const [unlabelled] = await builds()
    expect(unlabelled?.label).toBeUndefined()
  })
})
