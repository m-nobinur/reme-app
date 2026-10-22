import { ONBOARDING_STATUS } from "@workspace/contracts"
import { readOnboardingStatus } from "@workspace/ui/hooks/use-onboarding-status"
import { describe, expect, it, vi } from "vitest"

describe("an onboarding status part", () => {
  it("reads the panel again only when it names facts already written", () => {
    const refresh = vi.fn()
    const part = (data: unknown) => ({ type: ONBOARDING_STATUS, data })
    expect(
      readOnboardingStatus(
        part({ on: { kind: "fact", key: "business.offerings" }, facts: [] }),
        refresh
      )
    ).toBe(true)
    expect(refresh).not.toHaveBeenCalled()
    readOnboardingStatus(
      part({
        on: { kind: "next", next: "ask_open" },
        facts: ["business.offerings"],
      }),
      refresh
    )
    expect(refresh).toHaveBeenCalledTimes(1)
    // A part it cannot read is still the status's, and does nothing.
    expect(readOnboardingStatus(part({ on: "x" }), refresh)).toBe(true)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("leaves every other data part to the chat", () => {
    expect(
      readOnboardingStatus(
        { type: "data-card_answered", data: { tool_call_id: "c" } },
        vi.fn()
      )
    ).toBe(false)
  })
})
