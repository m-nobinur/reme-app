// @vitest-environment happy-dom
import { DNS_PROVIDERS } from "@workspace/contracts"
import { markOf } from "@workspace/ui/components/brand-mark"
import { ConnectRow } from "@workspace/ui/components/connect-row"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, it } from "vitest"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

it("has a vendored mark for every registry provider that names one", () => {
  for (const provider of DNS_PROVIDERS) {
    if (provider.mark !== null) expect(markOf(provider.mark)).toBeDefined()
  }
  expect(markOf("google-search-console")).toBeDefined()
  expect(markOf("godaddy")).not.toBe(markOf("cloudflare"))
  expect(markOf(null)).toBeUndefined()
  expect(markOf("hostinger-plus")).toBeUndefined()
})

it("draws a brand with no mark on a globe, and a new tab as one", async () => {
  const container = document.createElement("div")
  const root = createRoot(container)
  await act(async () =>
    root.render(
      createElement(ConnectRow, {
        name: "123-reg",
        line: "Open your DNS settings",
        href: "https://www.123-reg.co.uk/secure/",
        newTab: true,
      })
    )
  )
  const link = container.querySelector("a")
  expect(link?.getAttribute("target")).toBe("_blank")
  expect(link?.getAttribute("rel")).toBe("noopener noreferrer")
  expect(link?.textContent).toBe(
    "123-regOpen your DNS settings (opens in a new tab)"
  )
  expect(container.querySelector('[data-slot="brand-mark"] img')).toBeNull()
  expect(container.querySelector('[data-slot="brand-mark"] svg')).not.toBeNull()
  await act(async () => root.unmount())
})
