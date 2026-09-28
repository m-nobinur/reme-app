// @vitest-environment happy-dom
import { ToolGroup } from "@workspace/ui/components/assistant/tool-group"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, it } from "vitest"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

async function label(status: "running" | "complete") {
  const container = document.createElement("div")
  const root = createRoot(container)
  const group = {
    type: "group-tool",
    indices: [0, 1],
    status: { type: status },
  } as unknown as Parameters<typeof ToolGroup>[0]["group"]
  await act(async () => root.render(createElement(ToolGroup, { group })))
  const text = container.querySelector(
    '[data-slot="tool-group-trigger-label"]'
  )?.textContent
  await act(async () => root.unmount())
  return text
}

it("says what it is checking while it checks, and what it checked after", async () => {
  expect(await label("running")).toBe("Checking 2 things")
  expect(await label("complete")).toBe("Checked 2 things")
})
