// @vitest-environment happy-dom
import { Approval } from "@workspace/ui/components/assistant/approval"
import { ConnectGoogleRow } from "@workspace/ui/components/assistant/google"
import { type LiveCards, LiveCardsProvider } from "@workspace/ui/lib/live-cards"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

// The card reads the thread through assistant-ui's store; this stands in for
// it, since what is checked is the card, not the runtime.
const store = vi.hoisted(() => ({ running: false }))
vi.mock("@assistant-ui/react", async (original) => ({
  ...(await original<typeof import("@assistant-ui/react")>()),
  useAuiState: (select: (state: unknown) => unknown) =>
    select({
      message: {
        parts: [],
        isLast: true,
        status: store.running ? { type: "running" } : undefined,
      },
      thread: { isRunning: store.running },
    }),
  useAui: () => ({ thread: () => ({ append: vi.fn() }) }),
  useThreadViewport: () => undefined,
}))

/**
 * Draws the thread's slot for a connect_google call and returns its card,
 * under the workspace's live state when one is given.
 */
async function draw(props: Record<string, unknown>, live?: LiveCards) {
  const container = document.createElement("div")
  const root = createRoot(container)
  const card = createElement(Approval, {
    toolName: "connect_google",
    toolCallId: "call-1",
    args: {},
    argsText: "{}",
    ...props,
  } as never)
  await act(async () =>
    root.render(
      live ? createElement(LiveCardsProvider, { value: live }, card) : card
    )
  )
  const view = {
    text: container.textContent ?? "",
    links: [...container.querySelectorAll("a")].map((a) => ({
      text: a.textContent?.trim(),
      href: a.getAttribute("href"),
      target: a.getAttribute("target"),
    })),
    buttons: [...container.querySelectorAll("button")].map((b) =>
      b.textContent?.trim()
    ),
  }
  await act(async () => root.unmount())
  return view
}

it("offers the link as a plain same-tab navigation", async () => {
  const url = "https://reme.test/api/google/start"
  const card = await draw({ result: { url } })
  // The same tab keeps the referrer, which the start route returns to.
  expect(card.links).toEqual([
    {
      text: "Google Search ConsoleShow up when people near you search",
      href: url,
      target: null,
    },
  ])
  // Not now goes as the owner's words, so the assistant puts the offer off.
  expect(card.buttons).toEqual(["Not now"])
})

it("names the connected account and offers another", async () => {
  const card = await draw({ result: { connected: true, email: "a@b.co" } })
  expect(card.text).toContain("Connected as a@b.co")
  expect(card.links).toEqual([
    {
      text: "Use another Google account",
      href: "/api/google/start",
      target: null,
    },
  ])
})

it("says so when the feature is off, with nothing to press", async () => {
  const card = await draw({ result: { available: false } })
  expect(card.text).toContain("isn't available yet")
  expect(card.links).toEqual([])
})

it("shows a refusal as a line, not the api's words", async () => {
  const card = await draw({
    result: {
      outcome: "refused",
      error: { class: "authorization", code: "forbidden", message: "internal" },
    },
  })
  expect(card.text).not.toContain("internal")
  expect(card.links).toEqual([])
})

it("draws nothing while the site waits for its own domain: the assistant says why", async () => {
  const card = await draw({
    result: {
      outcome: "refused",
      error: {
        class: "validation",
        code: "search.needs_domain",
        message: "Google comes once the website's own domain is live.",
      },
    },
  })
  expect(card).toEqual({ text: "", links: [], buttons: [] })
})

it("keeps a call that has no result quiet, and an unreadable one honest", async () => {
  expect((await draw({})).links).toEqual([])
  const bad = await draw({ result: { url: "http://insecure.test" } })
  expect(bad.text).toContain("Couldn't connect Google")
  expect(bad.links).toEqual([])
})

const connected = (googleConnected: boolean | null): LiveCards => ({
  googleConnected,
  domainLive: () => false,
})

it("says connected, with nothing to press, on an offer from before the owner signed in", async () => {
  const url = "https://reme.test/api/google/start"
  const card = await draw({ result: { url } }, connected(true))
  expect(card.text).toBe("Connected to Google")
  expect(card.links).toEqual([])
  expect(card.buttons).toEqual([])
})

it("keeps the sign-in while the workspace says Google is not connected, or does not say", async () => {
  const url = "https://reme.test/api/google/start"
  for (const live of [connected(false), connected(null)]) {
    const card = await draw({ result: { url } }, live)
    expect(card.links.map((link) => link.href)).toEqual([url])
  }
})

it("turns a posted Connect Google row into the connected line once signed in", async () => {
  const container = document.createElement("div")
  const root = createRoot(container)
  await act(async () =>
    root.render(
      createElement(
        LiveCardsProvider,
        { value: connected(true) },
        createElement(ConnectGoogleRow)
      )
    )
  )
  expect(container.textContent).toBe("Connected to Google")
  expect(container.querySelector("a")).toBeNull()
  await act(async () => root.unmount())
})
