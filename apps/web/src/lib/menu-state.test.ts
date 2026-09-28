// @vitest-environment happy-dom
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, it } from "vitest"
import { useMenuState } from "./conversation-actions"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

it("forgets a rename and a failed archive once the owner moves on", async () => {
  let state: ReturnType<typeof useMenuState> | undefined
  function Probe({ id }: { id: string | undefined }) {
    state = useMenuState(id)
    return null
  }
  const root = createRoot(document.createElement("div"))
  await act(async () => root.render(createElement(Probe, { id: "a" })))
  await act(async () => {
    state?.setRenaming("a")
    state?.setFailed("a")
  })
  expect(state).toMatchObject({ renaming: "a", failed: "a" })
  // Another conversation, then back: nothing waits for them.
  await act(async () => root.render(createElement(Probe, { id: "b" })))
  await act(async () => root.render(createElement(Probe, { id: "a" })))
  expect(state).toMatchObject({ renaming: null, failed: null })
  await act(async () => root.unmount())
})
