import { describe, expect, it } from "vitest"
import { ApprovalDecision } from "../src/assignment.ts"
import { PreviewClaim, SitePointer } from "../src/site.ts"
import { samples } from "./samples.ts"

const claim = samples.PreviewClaim as Record<string, unknown>
const decision = samples.ApprovalDecision as Record<string, unknown>

describe("PreviewClaim", () => {
  it("binds a revision to one lower-case hostname", () => {
    expect(PreviewClaim.parse(claim)).toEqual(claim)
    for (const host of [
      "",
      "Preview.remeai.co.uk",
      "localhost",
      "a..b.co",
      `${"a".repeat(64)}.co`,
      "https://x.co",
    ]) {
      expect(PreviewClaim.safeParse({ ...claim, host }).success).toBe(false)
    }
    const { host: _host, ...hostless } = claim
    expect(PreviewClaim.safeParse(hostless).success).toBe(false)
  })
})

describe("SitePointer", () => {
  it("names the deployment version it was written from", () => {
    expect(SitePointer.parse(samples.SitePointer)).toEqual(samples.SitePointer)
    expect(
      SitePointer.safeParse({
        ...(samples.SitePointer as object),
        config_version: 0,
      }).success
    ).toBe(false)
  })
})

describe("ApprovalDecision", () => {
  it("records who decided, and cannot mix a console with a session", () => {
    expect(ApprovalDecision.parse(decision)).toEqual(decision)
    const owner = {
      kind: "owner_session",
      user_id: "user_01",
      session_id: "session_01",
    }
    expect(
      ApprovalDecision.safeParse({ ...decision, decided_by: owner }).success
    ).toBe(true)
    expect(
      ApprovalDecision.safeParse({
        ...decision,
        decided_by: { kind: "owner_session", user_id: "user_01" },
      }).success
    ).toBe(false)
    expect(
      ApprovalDecision.safeParse({
        ...decision,
        decided_by: { kind: "console", user_id: "user_01" },
      }).success
    ).toBe(false)
    expect(
      ApprovalDecision.safeParse({ ...decision, decision: "maybe" }).success
    ).toBe(false)
  })
})
