import type { OwnerTask } from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import {
  addressPlan,
  addressStage,
  type DomainFacts,
  googlePlan,
} from "../src/tasks.ts"

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

  it("waits on nothing for a failed connect, and on a new name for a failed purchase", () => {
    const connect = addressPlan(row({ state: "failed" }))
    expect(connect.state).toBe("later")
    expect(connect).not.toHaveProperty("steps")
    expect(
      stateOf(addressPlan(row({ origin: "purchased", state: "failed" })))
    ).toMatchObject({ choose: "blocked", records: "pending" })
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

describe("addressStage", () => {
  const task = (over: Record<string, unknown>) =>
    ({
      id: "00000000-0000-4000-8000-000000000001",
      kind: "address",
      state: "active",
      later_until: null,
      created_at: AT,
      done_at: null,
      detail: {},
      steps: [],
      ...over,
    }) as OwnerTask
  const step = (
    name: string,
    state: string,
    blocked_on: string | null = null
  ) => ({
    step: name,
    state,
    note: null,
    blocked_on,
    deadline: null,
    changed_at: null,
  })

  it("reads each stage the notes and the draft-ready line name", () => {
    expect(addressStage([])).toEqual({ stage: "none" })
    expect(addressStage([task({ state: "later", later_until: AT })])).toEqual({
      stage: "put_off",
      until: AT,
    })
    expect(
      addressStage([task({ steps: [step("find_out", "pending")] })])
    ).toEqual({
      stage: "unknown",
    })
    expect(
      addressStage([
        task({ steps: [step("find_out", "done"), step("choose", "blocked")] }),
      ])
    ).toEqual({ stage: "choosing" })
    expect(
      addressStage([
        task({
          detail: { name: "x.co.uk", origin: "buying_elsewhere" },
          steps: [step("purchase", "blocked", "owner_action")],
        }),
      ])
    ).toEqual({ stage: "buying_elsewhere", name: "x.co.uk" })
    expect(
      addressStage([
        task({
          detail: { name: "x.co.uk", origin: "buying_elsewhere" },
          steps: [step("purchase", "done")],
        }),
      ])
    ).toEqual({ stage: "bought", name: "x.co.uk" })
    expect(
      addressStage([
        task({
          detail: { name: "x.co.uk", origin: "purchased" },
          steps: [
            step("find_out", "done"),
            step("purchase", "blocked", "purchase"),
          ],
        }),
      ])
    ).toEqual({ stage: "paying", name: "x.co.uk" })
    expect(
      addressStage([
        task({
          detail: { name: "x.co.uk", origin: "owned" },
          steps: [step("find_out", "done"), step("records", "blocked")],
        }),
      ])
    ).toEqual({ stage: "connecting", name: "x.co.uk" })
    expect(
      addressStage([task({ state: "done", detail: { name: "x.co.uk" } })])
    ).toEqual({ stage: "live", name: "x.co.uk" })
  })
})
