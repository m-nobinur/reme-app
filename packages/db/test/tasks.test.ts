import { describe, expect, it } from "vitest"
import { addressPlan, type DomainFacts, googlePlan } from "../src/tasks.ts"

const AT = "2026-10-27T09:00:00.000Z"
const row = (over: Partial<DomainFacts>): DomainFacts => ({
  name: "northside.example",
  origin: "connected",
  state: "awaiting_dns",
  needs_txt: false,
  check: null,
  registered: false,
  provider: null,
  created_at: AT,
  activated_at: null,
  ...over,
})
const stateOf = (plan: ReturnType<typeof addressPlan>) =>
  Object.fromEntries(
    Object.entries(plan.steps ?? {}).map(([k, v]) => [k, v.state])
  )

describe("addressPlan", () => {
  it("walks a connect with a TXT through the certificate", () => {
    expect(
      stateOf(
        addressPlan(
          row({
            state: "verifying",
            needs_txt: true,
            check: "pending_verification",
          })
        )
      )
    ).toMatchObject({
      records: "done",
      ownership: "in_progress",
      certificate: "pending",
      loads: "pending",
    })
    expect(
      stateOf(addressPlan(row({ state: "verifying", check: "valid" })))
    ).toMatchObject({
      ownership: "skipped",
      certificate: "done",
      loads: "in_progress",
    })
  })

  it("holds an unpaid purchase on payment until the name is released", () => {
    const plan = addressPlan(
      row({ origin: "purchased", state: "awaiting_payment" })
    )
    expect(plan.steps?.purchase).toEqual({
      state: "blocked",
      blocked_on: "purchase",
      deadline: new Date("2026-10-27T11:20:00.000Z"),
    })
    expect(plan.detail).toMatchObject({ origin: "purchased" })
  })

  it("leaves the site loading on an active domain to the probe", () => {
    const plan = addressPlan(
      row({ state: "active", activated_at: "2026-10-27T10:00:00.000Z" })
    )
    expect(plan.state).toBe("active")
    expect(stateOf(plan)).toMatchObject({
      certificate: "done",
      loads: "in_progress",
    })
    expect(plan.done_at).toEqual(new Date("2026-10-27T10:00:00.000Z"))
  })

  it("leaves the steps alone for a removed or abandoned row", () => {
    expect(addressPlan(row({ state: "removed" }))).toMatchObject({
      state: "declined",
    })
    expect(
      addressPlan(row({ origin: "purchased", state: "abandoned" }))
    ).not.toHaveProperty("steps")
  })
})

describe("googlePlan", () => {
  it("leaves first data pending until Google has some", () => {
    const facts = {
      state: "active" as const,
      property: { state: "verified", sitemap: true },
    }
    expect(googlePlan({ ...facts, data: false }).steps?.first_data).toEqual({
      state: "pending",
    })
    expect(googlePlan({ ...facts, data: true }).steps?.first_data).toEqual({
      state: "done",
    })
  })
})
