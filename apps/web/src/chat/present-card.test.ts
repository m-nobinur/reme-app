// @vitest-environment happy-dom
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { ToolCard } from "./fixtures/tool-card"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

async function draw(args: unknown, status = { type: "complete" }) {
  const container = document.createElement("div")
  const root = createRoot(container)
  await act(async () =>
    root.render(
      createElement(ToolCard, {
        toolName: "present",
        toolCallId: "call-1",
        args,
        argsText: JSON.stringify(args),
        status,
        result: { outcome: "presented" },
      } as never)
    )
  )
  const view = {
    text: container.textContent ?? "",
    headers: [...container.querySelectorAll("th")].map((th) => th.textContent),
    cells: [...container.querySelectorAll("td")].map((td) => td.textContent),
    steps: [...container.querySelectorAll("ol > li")].map(
      (li) => li.textContent
    ),
    checklist: [...container.querySelectorAll("ul > li")].map(
      (li) => li.textContent
    ),
    facts: [...container.querySelectorAll("dl")].map((dl) => [
      dl.querySelector("dt")?.textContent,
      dl.querySelector("dd")?.textContent,
    ]),
    heading: container.querySelector("h3")?.textContent ?? null,
  }
  await act(async () => root.unmount())
  return view
}

const TREE = {
  _type: "Card",
  title: "Weekly or fortnightly",
  children: [
    { _type: "Text", text: "Weekly suits a busy family home." },
    {
      _type: "Table",
      columns: ["", "Weekly", "Fortnightly"],
      rows: [
        ["Price per visit", "£60", "£70"],
        ["Best for", "Busy homes"],
      ],
    },
    { _type: "Fact", label: "Your area", value: "Bristol" },
    { _type: "Steps", steps: ["Pick a day", "Send the quote"] },
    {
      _type: "Checklist",
      items: [{ label: "Prices set", done: true }, { label: "Hours set" }],
    },
  ],
}

it("draws every owner component from a present tree", async () => {
  const view = await draw(TREE)
  expect(view.heading).toBe("Weekly or fortnightly")
  expect(view.text).toContain("Weekly suits a busy family home.")
  expect(view.headers).toEqual(["", "Weekly", "Fortnightly"])
  // A short row is padded to the columns, so cells never shift.
  expect(view.cells).toEqual([
    "Price per visit",
    "£60",
    "£70",
    "Best for",
    "Busy homes",
    "",
  ])
  expect(view.facts).toEqual([["Your area", "Bristol"]])
  expect(view.steps).toEqual(["1Pick a day", "2Send the quote"])
  expect(view.checklist).toEqual(["Prices set, done", "Hours set, to do"])
})

it("drops a component outside the vocabulary and keeps the rest", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  const view = await draw({
    _type: "Card",
    children: [
      { _type: "Image", src: "https://example.com/x.png", alt: "x" },
      { _type: "Form", children: [{ _type: "Input", name: "card" }] },
      { _type: "Text", text: "Still here" },
    ],
  })
  warn.mockRestore()
  expect(view.text).toBe("Still here")
})

it("draws nothing for a node whose props fail its schema", async () => {
  const view = await draw({
    _type: "Card",
    children: [
      { _type: "Steps", steps: "Pick a day" },
      { _type: "Table", columns: ["a", "b", "c", "d", "e"], rows: [] },
      { _type: "Fact", label: "Only a label" },
      { _type: "Text", text: "Kept" },
    ],
  })
  expect(view.steps).toEqual([])
  expect(view.headers).toEqual([])
  expect(view.facts).toEqual([])
  expect(view.text).toBe("Kept")
})

it("draws nothing while the call's arguments still stream", async () => {
  const view = await draw(TREE, { type: "running" })
  expect(view.text).toBe("")
})
