// @vitest-environment happy-dom
import { WorkspaceShell } from "@workspace/ui/components/workspace-shell"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ""
})

const menu = createElement("button", {
  "aria-label": "Conversation actions",
  "data-slot": "conversation-actions",
  type: "button",
})

async function shell(
  renaming: Parameters<typeof WorkspaceShell>[0]["renaming"]
) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  // Renders without `act`, so a test can close the form in the same tick
  // as a click, the way the app's state change does.
  const draw = (next: typeof renaming) =>
    root.render(
      createElement(WorkspaceShell, {
        rail: null,
        panel: null,
        panelLine: null,
        title: "Weekend prices",
        menu,
        renaming: next,
        // biome-ignore lint/correctness/noChildrenProp: the shell's props type requires children, so they go with the rest.
        children: null,
      })
    )
  await act(async () => draw(renaming))
  return {
    container,
    render: (next: typeof renaming) => act(async () => draw(next)),
    draw,
  }
}

const field = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>(
    'input[aria-label="Conversation title"]'
  )

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

const frame = () =>
  act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve))
  })

it("keeps a pasted title's tail when its spaces are what made it long", async () => {
  const onSave = vi.fn(async () => undefined)
  const { container } = await shell({
    value: "",
    onSave,
    onCancel: () => undefined,
  })
  const input = field(container)
  if (!input) throw new Error("no field")
  expect(input.maxLength).toBe(-1)
  await typeInto(input, `Saturday${" ".repeat(200)}hours`)
  await act(async () => {
    input.form?.requestSubmit()
  })
  expect(onSave).toHaveBeenCalledWith("Saturday hours")
})

it("says a title will be cut before it is saved", async () => {
  const { container } = await shell({
    value: "",
    onSave: async () => undefined,
    onCancel: () => undefined,
  })
  const input = field(container)
  if (!input) throw new Error("no field")
  await typeInto(input, "a".repeat(121))
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "Titles keep their first 120 characters."
  )
})

it("hands focus back on cancel, and leaves it alone when the owner goes elsewhere", async () => {
  const { container, render, draw } = await shell({
    value: "Weekend prices",
    onSave: async () => undefined,
    onCancel: () => undefined,
  })
  const actions = () =>
    container.querySelector<HTMLElement>('[data-slot="conversation-actions"]')

  // Gone elsewhere: the form closes without a save or a cancel.
  document.body.focus()
  await render(undefined)
  await frame()
  expect(document.activeElement).not.toBe(actions())

  await render({
    value: "Weekend prices",
    onSave: async () => undefined,
    onCancel: () => undefined,
  })
  const cancel = [...container.querySelectorAll("button")].find(
    (each) => each.textContent === "Cancel"
  )
  await act(async () => {
    cancel?.click()
    draw(undefined)
  })
  await frame()
  expect(document.activeElement).toBe(actions())
})
