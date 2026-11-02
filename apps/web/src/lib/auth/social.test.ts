import { describe, expect, it } from "vitest"
import { enabledProviders } from "./social"

describe("enabledProviders", () => {
  it("is empty when the variable is unset or blank", () => {
    expect(enabledProviders(undefined)).toEqual([])
    expect(enabledProviders("")).toEqual([])
  })

  it("turns on a known provider", () => {
    expect(enabledProviders("GoogleOAuth")).toEqual(["GoogleOAuth"])
    expect(enabledProviders(" GoogleOAuth , GitHubOAuth ")).toEqual([
      "GoogleOAuth",
    ])
  })

  it("ignores names the app does not know, and is case sensitive", () => {
    expect(enabledProviders("GitHubOAuth,googleoauth")).toEqual([])
  })
})
