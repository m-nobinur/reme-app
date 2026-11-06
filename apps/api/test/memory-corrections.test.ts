import { MemoryView, STAFF_CORRECTIONS_KEY } from "@workspace/contracts"
import {
  readCorrections,
  supersedePrivateFact,
  type Tenancy,
  tenancy,
} from "@workspace/db"
import { skillsFor } from "@workspace/skills"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type Owner, owner, stubOrchestrator } from "./owner-fixture.ts"
import { stubJwksFetch } from "./sealed-session.ts"

/**
 * The owner's corrections for the Developer on the Memory page: listed for
 * the org and carried in the next build's brief. The page removes none: the
 * owner changes them by telling the assistant.
 */

const url = process.env.DATABASE_URL

describe.skipIf(!url)("the Developer's corrections on the Memory page", () => {
  const kit: Tenancy = tenancy(url as string, { max: 3 })
  let realFetch: typeof fetch
  let me: Owner
  const id = crypto.randomUUID()
  const sentence = "Never use stock photos on my site."

  /** What the Developer's next brief carries, read as the Workflow reads it. */
  const nextBrief = () =>
    kit.withOrg({ orgId: me.orgId }, async (db) =>
      skillsFor("developer", await readCorrections(db))
        .filter((s) => s.kind === "correction")
        .map((s) => s.body)
    )

  beforeAll(async () => {
    realFetch = globalThis.fetch
    globalThis.fetch = stubJwksFetch()
    me = await owner(kit, url as string, "memory-corrections")
    await kit.withOrg({ orgId: me.orgId }, (db) =>
      supersedePrivateFact(db, {
        orgId: me.orgId,
        key: STAFF_CORRECTIONS_KEY,
        factType: "owner",
        value: {
          lines: [
            {
              id,
              staff: "developer",
              text: sentence,
              at: new Date().toISOString(),
            },
          ],
        },
        provenance: { source: "owner_stated", confidence: 1 },
      })
    )
  }, 60_000)
  afterAll(async () => {
    globalThis.fetch = realFetch
    await kit.close()
  })

  it("lists the saved sentence, carries it in the next brief, and offers no remove", async () => {
    const page = await me.call(stubOrchestrator(), "/memory", {
      method: "GET",
    })
    expect(MemoryView.parse(await page.json()).corrections).toEqual([
      expect.objectContaining({ id, staff: "developer", text: sentence }),
    ])
    expect(await nextBrief()).toEqual([sentence])

    const removed = await me.call(
      stubOrchestrator(),
      `/memory/corrections/${id}`,
      { method: "DELETE" }
    )
    expect(removed.status).toBe(404)
    expect(await nextBrief()).toEqual([sentence])
  })
})
