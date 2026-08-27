import { describe, expect, it } from "vitest"
// @ts-expect-error -- a .mjs script with no types, imported for its pure parts
import { FORBIDDEN_NAMES, scan } from "./secret-scan.mjs"

/**
 * A gate nobody has watched fail is not known to work. So both fixtures: a
 * client bundle that is clean, and one carrying each thing the scan exists to
 * find. The second is why this file exists — the first would pass against a
 * scan that had been silently broken.
 */

const clean = [
  {
    path: "dist/client/assets/app-abc.js",
    // Real shapes from the built client: a public client id and an ordinary
    // fetch to our own origin, neither of which may be flagged.
    text: 'const c="client_01M0WWHM5TQAA6MDR2W910XA75";fetch("/_serverFn/signIn")',
  },
  { path: "dist/client/index.html", text: "<!doctype html><html lang=en>" },
]

describe("the client-bundle secret scan", () => {
  it("passes a clean bundle", () => {
    expect(scan(clean, [])).toEqual([])
  })

  it("does not look for the client id, which is public by design", () => {
    // It is in every authorization URL the browser follows, so a scan that
    // flagged it would fail on every correct build.
    expect(FORBIDDEN_NAMES).not.toContain("WORKOS_CLIENT_ID")
    expect(scan(clean, [])).toEqual([])
  })

  it("catches the environment variable name reaching the client", () => {
    // The leak that matters most: not a value, but server code in the client
    // graph, which is what ADR-026 said this check is for.
    const findings = scan(
      [{ path: "a.js", text: "process.env.WORKOS_API_KEY" }],
      []
    )
    expect(findings).toEqual(["a.js: contains WORKOS_API_KEY"])
  })

  it("catches the backend SDK being bundled for the browser", () => {
    const findings = scan(
      [{ path: "a.js", text: 'import{WorkOS}from"@workos-inc/node"' }],
      []
    )
    expect(findings[0]).toContain("@workos-inc/node")
  })

  it("catches a key pasted in as a literal, under any name", () => {
    // Assembled rather than written out. The pre-commit secret scan reads the
    // diff, and a fixture that looks exactly like a WorkOS key would be
    // rejected by it — correctly, which is the point of both checks.
    const shaped = ["sk", "test", "A1b2C3d4E5f6G7h8I9j0K1l2M3"].join("_")
    const findings = scan([{ path: "a.js", text: `const k="${shaped}"` }], [])
    expect(findings[0]).toContain("WorkOS API key")
  })

  it("catches the live value even when nothing names it", () => {
    const opaque = "not-a-recognisable-shape-at-all-1234"
    const findings = scan([{ path: "a.js", text: `x="${opaque}"` }], [opaque])
    expect(findings).toEqual(["a.js: contains a live secret value"])
  })

  it("ignores a short value, which would match everything", () => {
    expect(scan([{ path: "a.js", text: "const on=true" }], ["on"])).toEqual([])
  })

  it("reports every finding rather than stopping at the first", () => {
    const findings = scan(
      [
        { path: "a.js", text: "WORKOS_API_KEY" },
        { path: "b.js", text: "WORKOS_COOKIE_PASSWORD" },
      ],
      []
    )
    expect(findings).toHaveLength(2)
  })
})
