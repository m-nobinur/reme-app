import { afterEach, describe, expect, it, vi } from "vitest"
import { refuseUnlisted } from "./access"

afterEach(() => vi.unstubAllEnvs())

describe("refuseUnlisted", () => {
  it("lets everyone through when no list is set", () => {
    vi.stubEnv("ALLOWED_EMAILS", "")
    expect(refuseUnlisted("anyone@example.com")).toBeNull()
  })

  it("lets a listed address through and refuses the rest with a field message", () => {
    vi.stubEnv("ALLOWED_EMAILS", "me@gmail.com,*@team.example")
    expect(refuseUnlisted("m.e+test@gmail.com")).toBeNull()
    expect(refuseUnlisted("anyone@team.example")).toBeNull()
    expect(refuseUnlisted("other@gmail.com")).toMatchObject({
      code: "not_listed",
      field: "email",
    })
  })
})
