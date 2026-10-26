// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest"
import { followStep } from "./follow-step"

/** Boxes by top and bottom, since happy-dom lays nothing out. */
const box = (top: number, bottom: number) =>
  ({
    top,
    bottom,
    left: 0,
    right: 100,
    width: 100,
    height: bottom - top,
  }) as DOMRect

let root: HTMLElement
let scroller: HTMLElement
let first: HTMLElement
let second: HTMLElement
let scrolled: ReturnType<typeof vi.fn>

/** A panel body 100 tall at the top of the page, holding two steps. */
beforeEach(() => {
  document.body.innerHTML = `
    <div id="scroller" style="overflow-y: auto">
      <div id="root"><ol>
        <li id="first" data-state="now"></li>
        <li id="second" data-state="next"></li>
      </ol></div>
    </div>`
  root = document.getElementById("root") as HTMLElement
  scroller = document.getElementById("scroller") as HTMLElement
  first = document.getElementById("first") as HTMLElement
  second = document.getElementById("second") as HTMLElement
  scroller.getBoundingClientRect = () => box(0, 100)
  scrolled = vi.fn()
  second.scrollIntoView = scrolled as never
})

/** The current step moves from the first row to the second. */
const advance = () => {
  first.dataset.state = "done"
  second.dataset.state = "now"
}

it("does not scroll to the first current step it sees", () => {
  expect(followStep(root, null, false)).toBe(first)
  expect(scrolled).not.toHaveBeenCalled()
})

it("scrolls to the next step when the last one was in view", () => {
  first.getBoundingClientRect = () => box(60, 90)
  advance()
  expect(followStep(root, first, false)).toBe(second)
  expect(scrolled).toHaveBeenCalledWith({
    block: "nearest",
    behavior: "smooth",
  })
})

it("counts a row still partly in view, as one grown under its own bottom edge", () => {
  first.getBoundingClientRect = () => box(80, 140)
  advance()
  followStep(root, first, false)
  expect(scrolled).toHaveBeenCalledTimes(1)
})

it("scrolls without animation for someone who asked for less motion", () => {
  first.getBoundingClientRect = () => box(60, 90)
  advance()
  followStep(root, first, true)
  expect(scrolled).toHaveBeenCalledWith({ block: "nearest", behavior: "auto" })
})

it("leaves the owner's place when they scrolled away from the last step", () => {
  first.getBoundingClientRect = () => box(-80, -50)
  advance()
  expect(followStep(root, first, false)).toBe(second)
  expect(scrolled).not.toHaveBeenCalled()
})

it("does nothing when the panel is hidden and every box is empty", () => {
  scroller.getBoundingClientRect = () => box(0, 0)
  first.getBoundingClientRect = () => box(0, 0)
  advance()
  followStep(root, first, false)
  expect(scrolled).not.toHaveBeenCalled()
})

it("does not scroll again while the current step is the same", () => {
  first.getBoundingClientRect = () => box(60, 90)
  expect(followStep(root, first, false)).toBe(first)
  expect(scrolled).not.toHaveBeenCalled()
})
