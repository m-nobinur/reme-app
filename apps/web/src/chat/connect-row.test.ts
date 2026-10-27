// @vitest-environment happy-dom
import { markOf } from "@workspace/ui/components/brand-mark"
import { ConnectRow } from "@workspace/ui/components/connect-row"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, it } from "vitest"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

it("finds a provider's mark by its name, and none for a brand no library has", () => {
  expect(markOf("IONOS")).toBe(markOf("ionos"))
  expect(markOf("IONOS by 1&1")).toBe(markOf("IONOS"))
  expect(markOf("Google Search Console")).toBeDefined()
  expect(markOf("GoDaddy")).not.toBe(markOf("Cloudflare"))
  expect(markOf("123-reg")).toBeUndefined()
  expect(markOf("Fasthosts")).toBeUndefined()
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
