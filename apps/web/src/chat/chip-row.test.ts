// @vitest-environment happy-dom
import { ChipRow } from "@workspace/ui/components/assistant/chip-row"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it } from "vitest"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

/** A row 300 px wide holding 700 px of chips: 400 px to scroll. */
const METRICS = { scrollWidth: 700, clientWidth: 300 }

let root: Root
let host: HTMLElement

beforeEach(() => {
  for (const [key, value] of Object.entries(METRICS)) {
    Object.defineProperty(HTMLElement.prototype, key, {
      configurable: true,
      get: () => value,
    })
  }
  host = document.body.appendChild(document.createElement("div"))
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  for (const key of Object.keys(METRICS)) {
    Reflect.deleteProperty(HTMLElement.prototype, key)
  }
})

const row = () => host.querySelector<HTMLElement>('[data-slot="chip-row"]')

const scrollTo = (left: number) =>
  act(() => {
    const el = row()
    if (!el) throw new Error("no row")
    el.scrollLeft = left
    el.dispatchEvent(new Event("scroll"))
  })

it("fades the end of a row that overflows, and the start once it is scrolled", () => {
  act(() => {
    root.render(createElement(ChipRow, null, createElement("span", null, "a")))
  })
  expect(row()?.dataset.fadeEnd).toBe("true")
  expect(row()?.dataset.fadeStart).toBeUndefined()

  scrollTo(150)
  expect(row()?.dataset.fadeStart).toBe("true")
  expect(row()?.dataset.fadeEnd).toBe("true")

  scrollTo(400)
  expect(row()?.dataset.fadeStart).toBe("true")
  expect(row()?.dataset.fadeEnd).toBeUndefined()
})

it("has no fade when the chips fit", () => {
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get: () => 300,
  })
  act(() => {
    root.render(createElement(ChipRow, null, createElement("span", null, "a")))
  })
  expect(row()?.dataset.fadeEnd).toBeUndefined()
  expect(row()?.dataset.fadeStart).toBeUndefined()
})

it("brings a focused chip clear of the fade", () => {
  act(() => {
    root.render(
      createElement(ChipRow, null, createElement("span", { id: "chip" }, "a"))
    )
  })
  const el = row() as HTMLElement
  const calls: number[] = []
  el.scrollBy = ((options: ScrollToOptions) => {
    calls.push(options.left ?? 0)
  }) as typeof el.scrollBy
  el.getBoundingClientRect = () => ({ left: 0, right: 300 }) as DOMRect
  const chip = host.querySelector("#chip") as HTMLElement
  // Mostly under the end fade: its right edge sits 60 px past the edge's 32.
  chip.getBoundingClientRect = () => ({ left: 200, right: 328 }) as DOMRect
  act(() => {
    chip.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))
  })
  expect(calls).toEqual([60])
  // Hidden under the start fade, scrolled back.
  chip.getBoundingClientRect = () => ({ left: 10, right: 120 }) as DOMRect
  act(() => {
    chip.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))
  })
  expect(calls).toEqual([60, -22])
})
