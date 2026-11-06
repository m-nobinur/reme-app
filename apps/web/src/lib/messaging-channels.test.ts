// @vitest-environment happy-dom
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ACCOUNT, LINK, STARTED, stateOf } from "./channels-samples"

const server = vi.hoisted(() => ({
  getChannels: vi.fn(),
  startWhatsAppLink: vi.fn(),
  setChannelUpdates: vi.fn(),
  disconnectChannel: vi.fn(),
}))
vi.mock("@/lib/api/server", () => server)

const { MessagingChannels } = await import("./messaging-channels")

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root
const onState = vi.fn()
const refresh = vi.fn(() => Promise.resolve())

const show = async (whatsapp = stateOf().whatsapp) =>
  await act(async () =>
    root.render(
      createElement(MessagingChannels, { whatsapp, onState, refresh })
    )
  )

const press = async (text: string) => {
  const button = [...container.querySelectorAll("button")].find((node) =>
    node.textContent?.includes(text)
  )
  if (!button) throw new Error(`no button "${text}"`)
  await act(async () => button.click())
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse("2026-11-07T09:55:00.000Z") })
  server.getChannels.mockReset().mockResolvedValue(stateOf({ links: [] }))
  server.startWhatsAppLink.mockReset().mockResolvedValue(STARTED)
  server.setChannelUpdates.mockReset().mockResolvedValue({ done: true })
  server.disconnectChannel.mockReset().mockResolvedValue({ done: true })
  onState.mockReset()
  refresh.mockClear()
  container = document.createElement("div")
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  vi.useRealTimers()
})

it("offers the two ways to get a number, both still to come, when there is no account", async () => {
  await show(stateOf({ account: null, links: [] }).whatsapp)
  const rows = [...container.querySelectorAll('[data-slot="connect-row"]')]
  expect(rows.map((row) => row.textContent)).toEqual([
    "Use my WhatsApp Business numberKeep the number your customers already message",
    "Get a new numberReme sets up a UK mobile number for you",
  ])
  expect(rows.every((row) => (row as HTMLButtonElement).disabled)).toBe(true)
  expect(container.textContent).toContain("Coming soon")
})

it("says where a number that is not active stands", async () => {
  await show(
    stateOf({ account: { ...ACCOUNT, status: "pending" }, links: [] }).whatsapp
  )
  expect(container.textContent).toBe(
    "+447700900123 is being set up with WhatsApp."
  )
  await show(
    stateOf({ account: { ...ACCOUNT, status: "disabled" }, links: [] }).whatsapp
  )
  expect(container.textContent).toBe(
    "+447700900123 is switched off in WhatsApp."
  )
})

it("offers the chat once the number is active and no phone is linked", async () => {
  await show(stateOf({ links: [] }).whatsapp)
  expect(container.textContent).toContain("Sparkle Cleaning")
  expect(container.textContent).toContain("Chat with Reme here")
  expect(container.querySelector('[data-slot="switch"]')).toBeNull()
})

it("shows the code, its warnings and an Open WhatsApp link, and polls every 2 s", async () => {
  await show(stateOf({ links: [] }).whatsapp)
  await press("Chat with Reme here")

  expect(server.startWhatsAppLink).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain(
    "Scan this code with your phone's camera to chat with Reme on WhatsApp. Reme only sees the messages you send it, and you can disconnect at any time."
  )
  expect(container.textContent).toContain(
    "Anyone with this code can use Reme as you for the next 10 minutes. Don't share it."
  )
  expect(
    container.querySelector('[data-slot="qr-code"] svg path')?.getAttribute("d")
  ).toMatch(/^M\d+ \d+h1v1h-1z/)
  const open = container.querySelector(`a[href="${STARTED.url}"]`)
  expect(open?.textContent).toBe("Open WhatsApp (opens in a new tab)")
  expect(open?.className).toContain("sm:hidden")

  await act(async () => vi.advanceTimersByTimeAsync(2_000))
  await act(async () => vi.advanceTimersByTimeAsync(2_000))
  expect(server.getChannels).toHaveBeenCalledTimes(2)
  expect(onState).not.toHaveBeenCalled()
})

it("hands over the new state when the phone connects", async () => {
  await show(stateOf({ links: [] }).whatsapp)
  await press("Chat with Reme here")
  server.getChannels.mockResolvedValue(stateOf())
  await act(async () => vi.advanceTimersByTimeAsync(2_000))
  expect(onState).toHaveBeenCalledWith(stateOf())
})

it("expires the code after its time and asks for a new one on request", async () => {
  await show(stateOf({ links: [] }).whatsapp)
  await press("Chat with Reme here")
  await act(async () => vi.advanceTimersByTimeAsync(15 * 60_000))
  expect(container.textContent).toContain("This code has expired.")
  expect(container.querySelector('[data-slot="qr-code"]')).toBeNull()

  const reads = server.getChannels.mock.calls.length
  await act(async () => vi.advanceTimersByTimeAsync(10_000))
  expect(server.getChannels.mock.calls.length).toBe(reads)

  await press("New code")
  expect(server.startWhatsAppLink).toHaveBeenCalledTimes(2)
  expect(container.textContent).not.toContain("expired")
})

it("says so when no code could be made", async () => {
  server.startWhatsAppLink.mockResolvedValue(null)
  await show(stateOf({ links: [] }).whatsapp)
  await press("Chat with Reme here")
  expect(container.textContent).toContain("Reme could not make a code.")
  expect(container.textContent).toContain("New code")
  expect(server.getChannels).not.toHaveBeenCalled()
})

it("goes back from the code to the page", async () => {
  await show(stateOf({ links: [] }).whatsapp)
  await press("Chat with Reme here")
  await press("Back")
  expect(container.textContent).toContain("Chat with Reme here")
})

it("lists a linked chat with its updates switch and Disconnect", async () => {
  await show()
  expect(container.textContent).toContain(LINK.label)
  expect(container.textContent).not.toContain("Chat with Reme here")
  const toggle = container.querySelector('[role="switch"]')
  expect(toggle?.getAttribute("aria-checked")).toBe("true")
  expect(toggle?.getAttribute("aria-labelledby")).toBeTruthy()

  await act(async () => (toggle as HTMLElement).click())
  expect(server.setChannelUpdates).toHaveBeenCalledWith({
    data: { id: LINK.id, updates: false },
  })
  expect(refresh).toHaveBeenCalled()

  await press("Disconnect")
  expect(server.disconnectChannel).toHaveBeenCalledWith({
    data: { id: LINK.id },
  })
})

it("keeps the screen as it was and says so when a change is refused", async () => {
  server.disconnectChannel.mockResolvedValue({ done: false, reason: "gone" })
  await show()
  refresh.mockClear()
  await press("Disconnect")
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "That did not save. Try again."
  )
  expect(refresh).not.toHaveBeenCalled()
})
