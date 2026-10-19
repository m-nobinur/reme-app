import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { describe, expect, it, vi } from "vitest"

/**
 * `public/sw.js` run against a stand-in worker scope: what it shows, when it
 * stays quiet, and where a click goes.
 */

const code = readFileSync(
  new URL("../../public/sw.js", import.meta.url),
  "utf8"
)

type Handler = (event: unknown) => void

function worker(windows: Record<string, unknown>[]) {
  const handlers = new Map<string, Handler>()
  const shown: [string, NotificationOptions][] = []
  const self = {
    location: { origin: "https://app.example.test" },
    addEventListener: (type: string, fn: Handler) => handlers.set(type, fn),
    registration: {
      showNotification: async (title: string, options: NotificationOptions) => {
        shown.push([title, options])
      },
    },
    clients: {
      matchAll: async () => windows,
      openWindow: vi.fn(async () => undefined),
    },
  }
  runInNewContext(code, { self, URL })
  /** Fires an event and waits for what it handed to `waitUntil`. */
  const fire = async (type: string, event: Record<string, unknown>) => {
    let pending: Promise<unknown> = Promise.resolve()
    handlers.get(type)?.({
      ...event,
      waitUntil: (p: Promise<unknown>) => (pending = p),
    })
    await pending
  }
  return { self, shown, fire }
}

const pushOf = (body: unknown) => ({ data: { json: () => body } })
const note = {
  title: "Reme",
  body: "Your homepage is ready.",
  tag: "approval:c1",
  url: "/app/c/c1",
}

describe("the service worker", () => {
  it("shows a push under its tag, renotifying", async () => {
    const { shown, fire } = worker([])
    await fire("push", pushOf(note))
    expect(shown).toEqual([
      [
        "Reme",
        expect.objectContaining({
          body: note.body,
          tag: "approval:c1",
          renotify: true,
          data: { url: "/app/c/c1" },
        }),
      ],
    ])
  })

  it("shows nothing while an app window is visible and focused", async () => {
    const { shown, fire } = worker([
      { visibilityState: "visible", focused: true },
    ])
    await fire("push", pushOf(note))
    expect(shown).toHaveLength(0)
  })

  it("still shows it when the window is open but in the background", async () => {
    const { shown, fire } = worker([
      { visibilityState: "visible", focused: false },
      { visibilityState: "hidden", focused: false },
    ])
    await fire("push", pushOf(note))
    expect(shown).toHaveLength(1)
  })

  it("ignores a push that has no title", async () => {
    const { shown, fire } = worker([])
    await fire("push", pushOf({ body: "x" }))
    await fire("push", {})
    expect(shown).toHaveLength(0)
  })

  it("opens the conversation in an open window, or a new one", async () => {
    const navigate = vi.fn(async () => undefined)
    const open = {
      url: "https://app.example.test/app",
      focus: async () => ({ navigate }),
    }
    const withWindow = worker([open])
    const close = vi.fn()
    await withWindow.fire("notificationclick", {
      notification: { close, data: { url: "/app/c/c1" } },
    })
    expect(close).toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith("https://app.example.test/app/c/c1")

    const none = worker([])
    await none.fire("notificationclick", {
      notification: { close, data: { url: "/app/c/c1" } },
    })
    expect(none.self.clients.openWindow).toHaveBeenCalledWith(
      "https://app.example.test/app/c/c1"
    )
  })

  it("never opens an address outside the app", async () => {
    const { self, fire } = worker([])
    await fire("notificationclick", {
      notification: { close: vi.fn(), data: { url: "https://evil.test/" } },
    })
    expect(self.clients.openWindow).not.toHaveBeenCalled()
  })
})
