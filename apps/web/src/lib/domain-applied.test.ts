import { beforeEach, expect, it, vi } from "vitest"

const domainCheck = vi.fn()

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}))
vi.mock("@/lib/api/source", () => ({ source: { domainCheck } }))

const ORIGIN = "https://staging.remeai.co.uk"
const CHAT = "7f9c1b2e-4d3a-4b5c-8e6f-0a1b2c3d4e5f"

type Route = {
  options: {
    server: {
      handlers: { GET: (c: { request: Request }) => Promise<Response> }
    }
  }
}

/** The provider sending the tab back, with what it appended. */
async function back(query: string) {
  const { Route } = (await import(
    "../routes/api.domains.applied"
  )) as unknown as { Route: Route }
  const response = await Route.options.server.handlers.GET({
    request: new Request(`${ORIGIN}/api/domains/applied?${query}`),
  })
  return response.headers.get("location")
}

beforeEach(() => {
  domainCheck.mockReset().mockResolvedValue(undefined)
})

it("checks the domain and opens the conversation it was connected from", async () => {
  expect(await back(`name=sparkleclean.co.uk&c=${CHAT}`)).toBe(
    `${ORIGIN}/app/c/${CHAT}`
  )
  expect(domainCheck).toHaveBeenCalledWith("sparkleclean.co.uk")
})

it("checks nothing when the provider says it was cancelled, and never leaves the app", async () => {
  expect(
    await back(`name=sparkleclean.co.uk&c=${CHAT}&error=access_denied`)
  ).toBe(`${ORIGIN}/app/c/${CHAT}`)
  expect(await back("name=not%20a%20domain&c=//evil.example")).toBe(
    `${ORIGIN}/app`
  )
  expect(domainCheck).not.toHaveBeenCalled()
})
