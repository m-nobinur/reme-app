// @vitest-environment happy-dom
import { SITTING_GAP_MS } from "@workspace/contracts"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { followRegistrar, useBack } from "./use-back"

let root: Root
let container: HTMLDivElement
let seen: boolean[]

function Probe({
  waiting,
  lastSaidAt,
}: {
  waiting: boolean
  lastSaidAt: string | null
}) {
  seen.push(useBack(waiting, lastSaidAt))
  return null
}

const show = (waiting: boolean, lastSaidAt: string | null = null) =>
  act(async () => root.render(createElement(Probe, { waiting, lastSaidAt })))

const visibility = (state: "hidden" | "visible") =>
  act(async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: state,
    })
    document.dispatchEvent(new Event("visibilitychange"))
  })

beforeEach(async () => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  seen = []
  container = document.createElement("div")
  root = createRoot(container)
  await visibility("visible")
  await show(false)
})

afterEach(async () => {
  await act(async () => root.unmount())
})

const latest = () => seen.at(-1)

it("is back when the tab is shown again after a registrar link hid it", async () => {
  await show(true)
  followRegistrar()
  expect(latest()).toBe(false)
  await visibility("hidden")
  expect(latest()).toBe(false)
  await visibility("visible")
  expect(latest()).toBe(true)
})

it("is not back when the tab was hidden by something other than the registrar link", async () => {
  await show(true)
  await visibility("hidden")
  await visibility("visible")
  expect(latest()).toBe(false)
})

it("is back when the link was followed before the question began to wait", async () => {
  followRegistrar()
  await visibility("hidden")
  await show(true)
  await visibility("visible")
  expect(latest()).toBe(true)
})

it("forgets the return once nothing waits", async () => {
  await show(true)
  followRegistrar()
  await visibility("hidden")
  await visibility("visible")
  await show(false)
  expect(latest()).toBe(false)
  await show(true)
  expect(latest()).toBe(false)
})

it("is back in a new sitting, after the gap since their last message", async () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
  await show(true, ago(SITTING_GAP_MS - 60_000))
  expect(latest()).toBe(false)
  await show(true, ago(SITTING_GAP_MS + 60_000))
  expect(latest()).toBe(true)
  await show(false, ago(SITTING_GAP_MS + 60_000))
  expect(latest()).toBe(false)
})

it("is not back again after the owner writes while still on the page", async () => {
  const at = (minutes: number) =>
    new Date(Date.now() - minutes * 60_000).toISOString()
  await show(true, at(5))
  followRegistrar()
  await visibility("hidden")
  await visibility("visible")
  expect(latest()).toBe(true)
  await show(true, at(0))
  expect(latest()).toBe(false)
  await visibility("hidden")
  await visibility("visible")
  expect(latest()).toBe(true)
})

it("listens only while something waits", async () => {
  const add = vi.spyOn(document, "addEventListener")
  await show(false)
  expect(add).not.toHaveBeenCalledWith("visibilitychange", expect.anything())
  add.mockRestore()
})
